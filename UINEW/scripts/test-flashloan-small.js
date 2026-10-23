const hre = require("hardhat");
const { parseUnits } = require("ethers");

async function main() {
  console.log("🧪 Testing Small Flash Loan (1 DAI) on Sepolia...\n");

  const FLASH_LOAN_CONTRACT = "0x42859fff18EcB08Eafa48BC65d44899e1D6F02E8";
  const DAI_ADDRESS = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";

  // Smaller test amount: 1 DAI
  const FLASH_LOAN_AMOUNT = parseUnits("1", 18);

  const [signer] = await hre.ethers.getSigners();
  console.log(`📝 Using account: ${signer.address}`);

  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log(`💰 Account balance: ${hre.ethers.formatEther(balance)} ETH\n`);

  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanContract = FlashLoanArbitrage.attach(FLASH_LOAN_CONTRACT);

  console.log("📋 Test Details:");
  console.log("━".repeat(60));
  console.log(`Contract:         ${FLASH_LOAN_CONTRACT}`);
  console.log(`Token (DAI):      ${DAI_ADDRESS}`);
  console.log(`Amount:           ${hre.ethers.formatUnits(FLASH_LOAN_AMOUNT, 18)} DAI`);
  console.log(`Premium (0.05%):  ${hre.ethers.formatUnits(FLASH_LOAN_AMOUNT * 5n / 10000n, 18)} DAI`);
  console.log(`Total to repay:   ${hre.ethers.formatUnits(FLASH_LOAN_AMOUNT * 10005n / 10000n, 18)} DAI`);
  console.log("━".repeat(60));
  console.log();

  // Check contract DAI balance
  const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
  const daiContract = new hre.ethers.Contract(DAI_ADDRESS, ERC20_ABI, signer);
  const contractDaiBalance = await daiContract.balanceOf(FLASH_LOAN_CONTRACT);
  console.log(`💰 Contract DAI balance: ${hre.ethers.formatUnits(contractDaiBalance, 18)} DAI`);

  const totalNeeded = FLASH_LOAN_AMOUNT * 10005n / 10000n;
  if (contractDaiBalance < totalNeeded) {
    console.log(`⚠️  Warning: Contract might not have enough DAI to repay`);
    console.log(`   Needed: ${hre.ethers.formatUnits(totalNeeded, 18)} DAI`);
    console.log(`   Available: ${hre.ethers.formatUnits(contractDaiBalance, 18)} DAI`);
  } else {
    console.log(`✅ Contract has enough DAI to repay the loan`);
  }
  console.log();

  try {
    console.log("⏳ Requesting flash loan...");
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

    // Check logs for events
    if (receipt.logs.length > 0) {
      console.log(`📊 Events emitted: ${receipt.logs.length}`);
    }

  } catch (error) {
    console.error("❌ Flash Loan Failed!\n");
    console.error("Error:", error.message);

    if (error.message.includes("exceeds balance")) {
      console.error("\n💡 Issue: Contract doesn't have enough DAI");
      console.error("   The contract needs DAI to pay the flash loan premium");
      console.error(`   Required: ${hre.ethers.formatUnits(totalNeeded, 18)} DAI`);
      console.error(`   Available: ${hre.ethers.formatUnits(contractDaiBalance, 18)} DAI`);
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
