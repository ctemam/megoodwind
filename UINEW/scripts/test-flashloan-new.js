const hre = require("hardhat");
const { parseUnits } = require("ethers");

async function main() {
  console.log("🧪 Testing Flash Loan with New Contract on Sepolia...\n");

  const FLASH_LOAN_CONTRACT = "0x0F5D405A38B647DbC2C1B1F175E5e491330677a9";
  const DAI_ADDRESS = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";

  // Small test amount
  const FLASH_LOAN_AMOUNT = parseUnits("0.0005", 18);

  const [signer] = await hre.ethers.getSigners();
  console.log(`📝 Using account: ${signer.address}\n`);

  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanContract = FlashLoanArbitrage.attach(FLASH_LOAN_CONTRACT);

  // Check contract balance
  const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
  const daiContract = new hre.ethers.Contract(DAI_ADDRESS, ERC20_ABI, signer);
  const contractDaiBalance = await daiContract.balanceOf(FLASH_LOAN_CONTRACT);

  console.log("📋 Test Details:");
  console.log("━".repeat(60));
  console.log(`Amount to borrow: ${hre.ethers.formatUnits(FLASH_LOAN_AMOUNT, 18)} DAI`);
  console.log(`Contract balance: ${hre.ethers.formatUnits(contractDaiBalance, 18)} DAI`);
  console.log("━".repeat(60));
  console.log();

  try {
    console.log("⏳ Requesting flash loan (no arbitrage, just testing)...\n");

    const tx = await flashLoanContract.requestFlashLoan(
      DAI_ADDRESS,
      FLASH_LOAN_AMOUNT,
      "0x", // Empty params - no arbitrage
      { gasLimit: 500000 }
    );

    console.log(`📤 Transaction sent: ${tx.hash}`);
    console.log("⏳ Waiting for confirmation...\n");

    const receipt = await tx.wait();

    console.log("🎉 FLASH LOAN EXECUTED SUCCESSFULLY! 🎉\n");
    console.log("📋 Transaction Details:");
    console.log("━".repeat(60));
    console.log(`Status:           ✅ Success`);
    console.log(`Block:            ${receipt.blockNumber}`);
    console.log(`Gas Used:         ${receipt.gasUsed.toString()}`);
    console.log(`Transaction Hash: ${receipt.hash}`);
    console.log("━".repeat(60));
    console.log();
    console.log(`🔍 View on Etherscan:`);
    console.log(`   https://sepolia.etherscan.io/tx/${receipt.hash}`);
    console.log();

    console.log("✅ New contract is working correctly!");
    console.log("💡 Next step: Test with real DEX liquidity or deploy to mainnet");

  } catch (error) {
    console.error("❌ Flash Loan Failed!\n");
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
