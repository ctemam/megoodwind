# Smart Contract Deployment Guide

## Prerequisites

1. **Get Sepolia ETH**
   - Use a faucet: https://sepoliafaucet.com/
   - Or: https://www.alchemy.com/faucets/ethereum-sepolia

2. **Get Etherscan API Key**
   - Sign up at https://etherscan.io/
   - Go to API Keys section
   - Create a new API key

3. **Prepare Wallet**
   - Export your private key from MetaMask or other wallet
   - ⚠️ **NEVER share or commit your private key!**
   - Make sure you have some Sepolia ETH for gas

## Setup

1. **Update `.env.local` file**

```bash
# Add your private key (without 0x prefix)
PRIVATE_KEY=your_private_key_here

# Add your Etherscan API key
ETHERSCAN_API_KEY=your_etherscan_api_key_here
```

⚠️ **Security Warning**:
- Never commit `.env.local` to Git (it's already in `.gitignore`)
- Use a test wallet, not your main wallet
- Only use this wallet on testnets

## Deployment

### 1. Compile Contracts

```bash
npx hardhat compile
```

### 2. Deploy to Sepolia

```bash
npx hardhat run scripts/deploy.ts --network sepolia
```

This will:
- Deploy the FlashLoanArbitrage contract
- Print the contract address
- Save deployment info to `deployment-sepolia.json`

### 3. Verify Contract on Etherscan

After deployment, verify the contract:

```bash
npx hardhat verify --network sepolia <CONTRACT_ADDRESS> 0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A
```

Replace `<CONTRACT_ADDRESS>` with your deployed contract address.

## Contract Details

### FlashLoanArbitrage Contract

**Network**: Sepolia Testnet (Chain ID: 11155111)

**Key Features**:
- Aave V3 Flash Loan integration
- Owner-only access control
- Withdrawal functions
- Event logging

**Contract Functions**:
- `requestFlashLoan(address asset, uint256 amount)`: Request a flash loan
- `executeArbitrage(...)`: Execute arbitrage (to be implemented)
- `withdraw(address token, uint256 amount)`: Withdraw tokens
- `withdrawAll(address token)`: Withdraw all tokens

## Testing on Sepolia

### 1. Get Test Tokens

You'll need test tokens like WETH, USDC, DAI on Sepolia:
- Aave V3 Sepolia Faucet: https://staging.aave.com/faucet/
- Request tokens from the faucet

### 2. Test Flash Loan

```typescript
// Example: Request 1000 DAI flash loan
// DAI on Sepolia: 0x68194a729C2450ad26072b3D33ADaCbcef39D574
const dai = "0x68194a729C2450ad26072b3D33ADaCbcef39D574";
const amount = ethers.parseUnits("1000", 18); // 1000 DAI

await flashLoanArbitrage.requestFlashLoan(dai, amount);
```

## Important Addresses (Sepolia)

### Aave V3
- Pool Addresses Provider: `0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A`
- Pool: `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`

### Tokens
- WETH: `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9`
- USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- DAI: `0x68194a729C2450ad26072b3D33ADaCbcef39D574`
- LINK: `0x779877A7B0D9E8603169DdbD7836e478b4624789`

### DEXes
- Uniswap V2 Factory: `0x7E0987E5b3a30e3f2828572Bb659A548460a3003`
- Uniswap V3 Factory: `0x0227628f3F023bb0B980b67D528571c95c6DaC1c`

## Troubleshooting

### "Insufficient funds for gas"
- Make sure you have enough Sepolia ETH in your wallet
- Get more from a faucet

### "Invalid API key"
- Check your Etherscan API key in `.env.local`
- Make sure there are no extra spaces

### "Transaction reverted"
- Check if you have the required tokens
- Verify flash loan amount is not too high
- Check Aave V3 liquidity on Sepolia

## Next Steps

After successful deployment:

1. Update `lib/config.ts` with your contract address
2. Test basic functions (withdraw, requestFlashLoan)
3. Implement DEX swap logic in the contract
4. Test arbitrage execution

## Resources

- Aave V3 Docs: https://docs.aave.com/developers/
- Hardhat Docs: https://hardhat.org/docs
- Sepolia Explorer: https://sepolia.etherscan.io/
