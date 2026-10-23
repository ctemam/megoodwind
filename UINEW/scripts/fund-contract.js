const hre = require("hardhat");
const { parseUnits } = require("ethers");

async function main() {
  console.log("💰 Funding Contract for Flash Loan Test...\n");

  const FLASH_LOAN_CONTRACT = "0x42859fff18EcB08Eafa48BC65d44899e1D6F02E8";
  const DAI_ADDRESS = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357"; // Aave V3 Sepolia DAI

  const [signer] = await hre.ethers.getSigners();
  console.log(`📝 Using account: ${signer.address}\n`);

  // DAI Token ABI (minimal)
  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ];

  const daiContract = new hre.ethers.Contract(DAI_ADDRESS, ERC20_ABI, signer);

  // Check DAI balance
  const daiBalance = await daiContract.balanceOf(signer.address);
  console.log(`💵 Your DAI balance: ${hre.ethers.formatUnits(daiBalance, 18)} DAI\n`);

  if (daiBalance === 0n) {
    console.log("❌ No DAI balance found!");
    console.log("\n📌 To get test DAI on Sepolia:");
    console.log("   1. Visit Aave Faucet: https://staging.aave.com/faucet/");
    console.log("   2. Connect your wallet");
    console.log("   3. Request DAI tokens");
    console.log("   4. Wait for transaction to confirm");
    console.log("   5. Run this script again\n");
    process.exit(1);
  }

  // Transfer 1 DAI to contract (enough to cover premium for 100 DAI loan)
  // 0.05% of 100 DAI = 0.05 DAI, so 1 DAI is plenty
  const amountToTransfer = parseUnits("1", 18);

  console.log(`📤 Transferring 1 DAI to contract...`);
  console.log(`   From: ${signer.address}`);
  console.log(`   To:   ${FLASH_LOAN_CONTRACT}`);
  console.log();

  try {
    const tx = await daiContract.transfer(FLASH_LOAN_CONTRACT, amountToTransfer);
    console.log(`⏳ Transaction sent: ${tx.hash}`);
    await tx.wait();

    console.log("✅ Transfer successful!\n");

    // Verify contract balance
    const contractBalance = await daiContract.balanceOf(FLASH_LOAN_CONTRACT);
    console.log(`💰 Contract DAI balance: ${hre.ethers.formatUnits(contractBalance, 18)} DAI`);
    console.log("\n✨ Contract is now ready for flash loan test!");
    console.log("   Run: npx hardhat run scripts/test-flashloan.js --network sepolia\n");

  } catch (error) {
    console.error("❌ Transfer failed:", error.message);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
