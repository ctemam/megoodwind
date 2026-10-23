const hre = require("hardhat");
const { parseUnits } = require("ethers");

async function main() {
  console.log("🧪 Testing TINY Flash Loan (0.0005 DAI) on Sepolia...\n");

  const FLASH_LOAN_CONTRACT = "0x42859fff18EcB08Eafa48BC65d44899e1D6F02E8";
  const DAI_ADDRESS = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";

  // Tiny amount within available liquidity: 0.0005 DAI
  const FLASH_LOAN_AMOUNT = parseUnits("0.0005", 18);

  const [signer] = await hre.ethers.getSigners();
  console.log(`📝 Using account: ${signer.address}\n`);

  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanContract = FlashLoanArbitrage.attach(FLASH_LOAN_CONTRACT);

  // Check contract DAI balance
  const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
  const daiContract = new hre.ethers.Contract(DAI_ADDRESS, ERC20_ABI, signer);
  const contractDaiBalance = await daiContract.balanceOf(FLASH_LOAN_CONTRACT);

  console.log("📋 Test Details:");
  console.log("━".repeat(60));
  console.log(`Amount to borrow: ${hre.ethers.formatUnits(FLASH_LOAN_AMOUNT, 18)} DAI`);
  console.log(`Premium (0.05%):  ${hre.ethers.formatUnits(FLASH_LOAN_AMOUNT * 5n / 10000n, 18)} DAI`);
  console.log(`Total to repay:   ${hre.ethers.formatUnits(FLASH_LOAN_AMOUNT * 10005n / 10000n, 18)} DAI`);
  console.log(`Contract balance: ${hre.ethers.formatUnits(contractDaiBalance, 18)} DAI`);
  console.log("━".repeat(60));

  const totalNeeded = FLASH_LOAN_AMOUNT * 10005n / 10000n;
  if (contractDaiBalance >= totalNeeded - FLASH_LOAN_AMOUNT) {
    console.log(`✅ Contract has enough DAI for premium\n`);
  } else {
    console.log(`⚠️  Warning: Might not have enough DAI\n`);
  }

  try {
    console.log("⏳ Requesting flash loan...");
    console.log("   This tests the full Aave V3 flash loan cycle:\n");
    console.log("   1. 🏦 Borrow 0.0005 DAI from Aave V3");
    console.log("   2. ⚙️  Execute arbitrage logic (empty for now)");
    console.log("   3. 💸 Repay 0.0005 DAI + 0.0000025 DAI premium");
    console.log("   4. ✅ All in ONE atomic transaction\n");

    const tx = await flashLoanContract.requestFlashLoan(
      DAI_ADDRESS,
      FLASH_LOAN_AMOUNT,
      { gasLimit: 500000 }
    );

    console.log(`📤 Transaction sent: ${tx.hash}`);
    console.log("⏳ Waiting for confirmation...\n");

    const receipt = await tx.wait();

    console.log("🎉 FLASH LOAN EXECUTED SUCCESSFULLY! 🎉\n");
    console.log("📋 Transaction Details:");
    console.log("━".repeat(60));
    console.log(`Status:           ✅ Success`);
    console.log(`Block Number:     ${receipt.blockNumber}`);
    console.log(`Gas Used:         ${receipt.gasUsed.toString()}`);
    console.log(`Transaction Hash: ${receipt.hash}`);
    console.log("━".repeat(60));
    console.log();
    console.log(`🔍 View on Etherscan:`);
    console.log(`   https://sepolia.etherscan.io/tx/${receipt.hash}`);
    console.log();
    console.log("✨ What happened:");
    console.log("   1. Your contract successfully borrowed DAI from Aave V3");
    console.log("   2. Executed the callback function (executeOperation)");
    console.log("   3. Repaid the loan with premium");
    console.log("   4. All within a SINGLE atomic transaction!");
    console.log();
    console.log("🚀 Next Steps:");
    console.log("   - Implement actual DEX swap logic in executeOperation");
    console.log("   - Test arbitrage between Uniswap V2/V3");
    console.log("   - Deploy to mainnet when ready");

  } catch (error) {
    console.error("❌ Flash Loan Failed!\n");
    console.error("Error:", error.message);

    if (error.message.includes("exceeds balance")) {
      console.error("\n💡 The contract doesn't have enough DAI for the premium");
    } else if (error.message.includes("reserve")) {
      console.error("\n💡 The reserve might not have enough liquidity");
      console.error("   Try an even smaller amount");
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
