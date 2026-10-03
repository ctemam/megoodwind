//! ERC-4337 v0.6 UserOperation assembler (SimpleAccount-compatible).
//!
//! Wraps a `to`/`calldata` contract call into a packed UserOperation that a
//! bundler (Pimlico) can execute through a smart account instead of a raw EOA
//! transaction — the gasless path: gas is paid by a Pimlico paymaster
//! (sponsorship policy), never by a native-token wallet balance.

use alloy::providers::Provider;
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::{sol, SolCall};
use anyhow::{Context, Result};

use arb_rpc::Endpoint;

/// Canonical ERC-4337 EntryPoint v0.6 — deployed on Base, BSC, and most EVM chains.
pub const ENTRY_POINT_V06: &str = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
/// eth-infinitism SimpleAccountFactory (v0.6), deterministic CREATE2 address.
pub const SIMPLE_ACCOUNT_FACTORY: &str = "0x9406Cc6185a346906296840746125a0E44976454";

sol! {
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function getAddress(address owner, uint256 salt) external view returns (address);
    function createAccount(address owner, uint256 salt) external returns (address);
    function execute(address dest, uint256 value, bytes func) external;
}

/// Gas fields of a UserOperation.
#[derive(Debug, Clone, Copy)]
pub struct UserOpGas {
    pub call_gas_limit: U256,
    pub verification_gas_limit: U256,
    pub pre_verification_gas: U256,
    pub max_fee_per_gas: U256,
    pub max_priority_fee_per_gas: U256,
}

/// A fully packed v0.6 UserOperation, ready for `eth_sendUserOperation`.
#[derive(Debug, Clone)]
pub struct PackedUserOp {
    pub sender: Address,
    pub nonce: U256,
    pub init_code: Bytes,
    pub call_data: Bytes,
    pub gas: UserOpGas,
    pub paymaster_and_data: Bytes,
    pub signature: Bytes,
}

impl PackedUserOp {
    /// v0.6 inner hash: keccak over abi.encodePacked of all fields.
    fn pack_hash(&self) -> B256 {
        let mut buf = Vec::with_capacity(416);
        buf.extend_from_slice(&[0u8; 12]);
        buf.extend_from_slice(self.sender.as_slice());
        buf.extend_from_slice(&self.nonce.to_be_bytes::<32>());
        buf.extend_from_slice(keccak256(&self.init_code).as_slice());
        buf.extend_from_slice(keccak256(&self.call_data).as_slice());
        buf.extend_from_slice(&self.gas.call_gas_limit.to_be_bytes::<32>());
        buf.extend_from_slice(&self.gas.verification_gas_limit.to_be_bytes::<32>());
        buf.extend_from_slice(&self.gas.pre_verification_gas.to_be_bytes::<32>());
        buf.extend_from_slice(&self.gas.max_fee_per_gas.to_be_bytes::<32>());
        buf.extend_from_slice(&self.gas.max_priority_fee_per_gas.to_be_bytes::<32>());
        buf.extend_from_slice(keccak256(&self.paymaster_and_data).as_slice());
        keccak256(buf)
    }

    /// The hash the smart account owner signs (v0.6): keccak over
    /// abi.encode(packHash, entryPoint, chainId).
    pub fn user_op_hash(&self, entry_point: Address, chain_id: u64) -> B256 {
        let mut buf = Vec::with_capacity(96);
        buf.extend_from_slice(self.pack_hash().as_slice());
        buf.extend_from_slice(&[0u8; 12]);
        buf.extend_from_slice(entry_point.as_slice());
        buf.extend_from_slice(&U256::from(chain_id).to_be_bytes::<32>());
        keccak256(buf)
    }

    /// JSON form expected by bundler RPCs (all quantities hex-encoded).
    pub fn to_json(&self) -> serde_json::Value {
        fn q(v: &U256) -> String {
            format!("0x{:x}", v)
        }
        serde_json::json!({
            "sender": format!("{:#x}", self.sender),
            "nonce": q(&self.nonce),
            "initCode": format!("0x{}", hex::encode(&self.init_code)),
            "callData": format!("0x{}", hex::encode(&self.call_data)),
            "callGasLimit": q(&self.gas.call_gas_limit),
            "verificationGasLimit": q(&self.gas.verification_gas_limit),
            "preVerificationGas": q(&self.gas.pre_verification_gas),
            "maxFeePerGas": q(&self.gas.max_fee_per_gas),
            "maxPriorityFeePerGas": q(&self.gas.max_priority_fee_per_gas),
            "paymasterAndData": format!("0x{}", hex::encode(&self.paymaster_and_data)),
            "signature": format!("0x{}", hex::encode(&self.signature)),
        })
    }
}

/// Assembles UserOperations for one smart account owner (the engine EOA).
#[derive(Clone)]
pub struct UserOpAssembler {
    pub owner: Address,
    pub salt: U256,
    pub entry_point: Address,
    pub account_factory: Address,
    pub signer: PrivateKeySigner,
    pub chain_id: u64,
}

impl UserOpAssembler {
    /// Counterfactual sender address: SimpleAccountFactory.getAddress(owner, salt).
    pub async fn sender(&self, endpoint: &Endpoint) -> Result<Address> {
        let data = getAddressCall {
            owner: self.owner,
            salt: self.salt,
        }
        .abi_encode()
        .into();
        let (ret, _) = endpoint
            .eth_call_timed(self.account_factory, data)
            .await
            .context("factory.getAddress failed — is the SimpleAccountFactory deployed on this chain?")?;
        getAddressCall::abi_decode_returns(&ret).map_err(|e| anyhow::anyhow!("decode getAddress: {e}"))
    }

    /// Build an unsigned UserOperation carrying `to`/`inner` via
    /// `SimpleAccount.execute(dest, 0, func)`. Paymaster data may be empty
    /// (self-funded) and is later replaced by `pm_sponsorUserOperation` output.
    pub async fn assemble_unsigned(
        &self,
        endpoint: &Endpoint,
        to: Address,
        inner: Bytes,
        gas: UserOpGas,
        paymaster_and_data: Bytes,
    ) -> Result<PackedUserOp> {
        let sender = self.sender(endpoint).await?;

        let deployed = endpoint
            .provider()
            .get_code_at(sender)
            .await
            .map(|c| !c.is_empty())
            .unwrap_or(false);
        let init_code = if deployed {
            Bytes::new()
        } else {
            let mut ic = Vec::with_capacity(20 + 68);
            ic.extend_from_slice(self.account_factory.as_slice());
            ic.extend_from_slice(
                &createAccountCall {
                    owner: self.owner,
                    salt: self.salt,
                }
                .abi_encode(),
            );
            Bytes::from(ic)
        };

        let nonce_data = getNonceCall {
            sender,
            key: alloy_primitives::Uint::<192, 3>::ZERO,
        }
        .abi_encode()
        .into();
        let (nonce_ret, _) = endpoint
            .eth_call_timed(self.entry_point, nonce_data)
            .await
            .context("entryPoint.getNonce failed")?;
        let nonce =
            getNonceCall::abi_decode_returns(&nonce_ret).map_err(|e| anyhow::anyhow!("decode getNonce: {e}"))?;

        let call_data = Bytes::from(
            executeCall {
                dest: to,
                value: U256::ZERO,
                func: inner,
            }
            .abi_encode(),
        );

        // Deploying the account inside the UserOp costs extra verification gas.
        let gas = if init_code.is_empty() {
            gas
        } else {
            UserOpGas {
                verification_gas_limit: gas.verification_gas_limit + U256::from(400_000u64),
                ..gas
            }
        };

        Ok(PackedUserOp {
            sender,
            nonce,
            init_code,
            call_data,
            gas,
            paymaster_and_data,
            signature: Bytes::new(),
        })
    }

    /// Sign the op with the owner key; returns a signed clone.
    /// SimpleAccount validates ECDSA over the EIP-191 personal-sign digest
    /// (`toEthSignedMessageHash(userOpHash)`), not the raw hash.
    pub async fn sign(&self, op: &PackedUserOp) -> Result<PackedUserOp> {
        let hash = op.user_op_hash(self.entry_point, self.chain_id);
        let sig = self.signer.sign_message(hash.as_slice()).await?;
        let mut signed = op.clone();
        signed.signature = Bytes::from(sig.as_bytes().to_vec());
        Ok(signed)
    }
}
