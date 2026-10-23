const hre = require("hardhat");
const { parseUnits } = require("ethers");

async function main() {
  console.log("🧪 Testing Flash Loan with WETH on Sepolia...\n");

  const FLASH_LOAN_CONTRACT = "0x42859fff18EcB08Eafa48BC65d44899e1D6F02E8";
  const WETH_ADDRESS = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"; // Sepolia WETH

  // Test amount: 0.01 WETH (small amount for testing)
  const FLASH_LOAN_AMOUNT = parseUnits("0.01", 18);

  const [signer] = await hre.ethers.getSigners();
  console.log(`📝 Using account: ${signer.address}`);

  const ethBalance = await hre.ethers.provider.getBalance(signer.address);
  console.log(`💰 ETH balance: ${hre.ethers.formatEther(ethBalance)} ETH\n`);

  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanContract = FlashLoanArbitrage.attach(FLASH_LOAN_CONTRACT);

  console.log("📋 Test Details:");
  console.log("━".repeat(60));
  console.log(`Contract:         ${FLASH_LOAN_CONTRACT}`);
  console.log(`Token:            WETH`);
  console.log(`Token Address:    ${WETH_ADDRESS}`);
  console.log(`Amount:           ${hre.ethers.formatEther(FLASH_LOAN_AMOUNT)} WETH`);
  console.log(`Premium (0.05%):  ${hre.ethers.formatEther(FLASH_LOAN_AMOUNT * 5n / 10000n)} WETH`);
  console.log(`Total to repay:   ${hre.ethers.formatEther(FLASH_LOAN_AMOUNT * 10005n / 10000n)} WETH`);
  console.log("━".repeat(60));
  console.log();

  // Check contract WETH balance
  const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
  const wethContract = new hre.ethers.Contract(WETH_ADDRESS, ERC20_ABI, signer);
  const contractWethBalance = await wethContract.balanceOf(FLASH_LOAN_CONTRACT);
  console.log(`💰 Contract WETH balance: ${hre.ethers.formatEther(contractWethBalance)} WETH`);

  const contractEthBalance = await hre.ethers.provider.getBalance(FLASH_LOAN_CONTRACT);
  console.log(`💰 Contract ETH balance: ${hre.ethers.formatEther(contractEthBalance)} ETH`);

  const totalNeeded = FLASH_LOAN_AMOUNT * 10005n / 10000n;
  console.log(`📊 Premium needed: ${hre.ethers.formatEther(FLASH_LOAN_AMOUNT * 5n / 10000n)} WETH`);

  if (contractWethBalance + contractEthBalance < totalNeeded) {
    console.log(`\n⚠️  Note: Contract has ${hre.ethers.formatEther(contractWethBalance + contractEthBalance)} WETH+ETH`);
    console.log(`   Flash loan will work if Aave provides the borrowed amount`);
  } else {
    console.log(`\n✅ Contract should have enough to repay`);
  }
  console.log();

  try {
    console.log("⏳ Requesting flash loan...");
    const tx = await flashLoanContract.requestFlashLoan(
      WETH_ADDRESS,
      FLASH_LOAN_AMOUNT,
      { gasLimit: 500000 } // Set explicit gas limit
    );

    console.log(`📤 Transaction sent: ${tx.hash}`);
    console.log("⏳ Waiting for confirmation...\n");

    const receipt = await tx.wait();

    console.log("✅ Flash Loan Executed Successfully!\n");
    console.log("📋 Transaction Details:");
    console.log("━".repeat(60));
    console.log(`Status:           Success ✅`);
    console.log(`Block:            ${receipt.blockNumber}`);
    console.log(`Gas Used:         ${receipt.gasUsed.toString()}`);
    console.log(`Transaction Hash: ${receipt.hash}`);
    console.log("━".repeat(60));
    console.log();
    console.log(`🔍 View on Etherscan:`);
    console.log(`   https://sepolia.etherscan.io/tx/${receipt.hash}`);
    console.log();

    console.log(`🎉 Flash Loan Test Completed Successfully!`);
    console.log(`   You've successfully borrowed ${hre.ethers.formatEther(FLASH_LOAN_AMOUNT)} WETH`);
    console.log(`   and repaid it with premium in a single transaction!`);

  } catch (error) {
    console.error("❌ Flash Loan Failed!\n");
    console.error("Error:", error.message);

    if (error.message.includes("exceeds balance")) {
      console.error("\n💡 Possible issues:");
      console.error("   1. Contract needs WETH to pay premium");
      console.error("   2. Send some ETH to contract first, or");
      console.error("   3. Deposit WETH to contract");
    } else if (error.message.includes("RESERVE_INACTIVE")) {
      console.error("\n💡 This reserve might not be active on Aave V3 Sepolia");
      console.error("   Try a different token");
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
