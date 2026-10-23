const hre = require("hardhat");
const { parseUnits } = require("ethers");

async function main() {
  console.log("🧪 Testing Flash Loan on Sepolia...\n");

  // Contract address from deployment
  const FLASH_LOAN_CONTRACT = "0x42859fff18EcB08Eafa48BC65d44899e1D6F02E8";

  // Sepolia DAI address (Aave V3 testnet)
  const DAI_ADDRESS = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";

  // Test amount: 100 DAI
  const FLASH_LOAN_AMOUNT = parseUnits("100", 18);

  // Get signer
  const [signer] = await hre.ethers.getSigners();
  console.log(`📝 Using account: ${signer.address}`);

  // Check balance
  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log(`💰 Account balance: ${hre.ethers.formatEther(balance)} ETH\n`);

  if (balance === 0n) {
    console.error("❌ No ETH balance! Get Sepolia ETH from faucet first.");
    process.exit(1);
  }

  // Get contract instance
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanContract = FlashLoanArbitrage.attach(FLASH_LOAN_CONTRACT);

  console.log("📋 Test Details:");
  console.log("━".repeat(60));
  console.log(`Contract:         ${FLASH_LOAN_CONTRACT}`);
  console.log(`Token (DAI):      ${DAI_ADDRESS}`);
  console.log(`Amount:           ${hre.ethers.formatUnits(FLASH_LOAN_AMOUNT, 18)} DAI`);
  console.log("━".repeat(60));
  console.log();

  // Verify contract owner
  try {
    const owner = await flashLoanContract.owner();
    console.log(`🔐 Contract owner: ${owner}`);

    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      console.error(`❌ Error: You (${signer.address}) are not the contract owner!`);
      console.error(`   Contract owner is: ${owner}`);
      process.exit(1);
    }
    console.log("✅ Owner verification passed\n");
  } catch (error) {
    console.error("❌ Failed to verify owner:", error.message);
    process.exit(1);
  }

  // Request flash loan
  try {
    console.log("⏳ Requesting flash loan...");
    console.log("   This will:");
    console.log("   1. Borrow 100 DAI from Aave V3");
    console.log("   2. Execute arbitrage logic (currently empty)");
    console.log("   3. Repay loan + premium (0.05%)");
    console.log();

    const tx = await flashLoanContract.requestFlashLoan(
      DAI_ADDRESS,
      FLASH_LOAN_AMOUNT
    );

    console.log(`📤 Transaction sent: ${tx.hash}`);
    console.log("⏳ Waiting for confirmation...\n");

    const receipt = await tx.wait();

    console.log("✅ Flash Loan Executed Successfully!\n");
    console.log("📋 Transaction Details:");
    console.log("━".repeat(60));
    console.log(`Status:           Success`);
    console.log(`Block:            ${receipt.blockNumber}`);
    console.log(`Gas Used:         ${receipt.gasUsed.toString()}`);
    console.log(`Transaction Hash: ${receipt.hash}`);
    console.log("━".repeat(60));
    console.log();
    console.log(`🔍 View on Etherscan:`);
    console.log(`   https://sepolia.etherscan.io/tx/${receipt.hash}`);
    console.log();

    // Check contract balance after
    const contractBalance = await hre.ethers.provider.getBalance(FLASH_LOAN_CONTRACT);
    if (contractBalance > 0n) {
      console.log(`💰 Contract has ${hre.ethers.formatEther(contractBalance)} ETH`);
      console.log("   You can withdraw it using the withdraw() function");
    }

  } catch (error) {
    console.error("❌ Flash Loan Failed!\n");
    console.error("Error:", error.message);

    if (error.message.includes("insufficient funds")) {
      console.error("\n💡 Issue: Insufficient ETH for gas fees");
      console.error("   Get more Sepolia ETH from:");
      console.error("   - https://sepoliafaucet.com/");
      console.error("   - https://www.alchemy.com/faucets/ethereum-sepolia");
    } else if (error.message.includes("execution reverted")) {
      console.error("\n💡 Issue: Contract execution reverted");
      console.error("   Possible reasons:");
      console.error("   1. Contract doesn't have enough funds to repay flash loan");
      console.error("   2. Arbitrage logic failed");
      console.error("   3. Token approval issues");
    }

    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
