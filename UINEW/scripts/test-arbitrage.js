const hre = require("hardhat");
const { parseUnits } = require("ethers");

async function main() {
  console.log("🔄 Testing Flash Loan Arbitrage on Sepolia...\n");

  // Contract addresses
  const FLASH_LOAN_CONTRACT = "0x0F5D405A38B647DbC2C1B1F175E5e491330677a9";
  const DAI_ADDRESS = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357"; // Aave V3 Sepolia DAI
  const USDC_ADDRESS = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8"; // Aave V3 Sepolia USDC

  // Uniswap V2 and V3 Router addresses on Sepolia
  const UNISWAP_V2_ROUTER = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
  const UNISWAP_V3_ROUTER = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";

  // Test with very small amount due to limited liquidity
  const FLASH_LOAN_AMOUNT = parseUnits("0.0005", 18); // 0.0005 DAI

  const [signer] = await hre.ethers.getSigners();
  console.log(`📝 Signer: ${signer.address}\n`);

  // Get contract instance
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanContract = FlashLoanArbitrage.attach(FLASH_LOAN_CONTRACT);

  // Check contract DAI balance
  const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
  const daiContract = new hre.ethers.Contract(DAI_ADDRESS, ERC20_ABI, signer);
  const contractDaiBalance = await daiContract.balanceOf(FLASH_LOAN_CONTRACT);

  console.log("📋 Arbitrage Test Details:");
  console.log("━".repeat(70));
  console.log(`Strategy:         DAI -> USDC -> DAI`);
  console.log(`Buy DEX:          Uniswap V2 (DAI -> USDC)`);
  console.log(`Sell DEX:         Uniswap V3 (USDC -> DAI)`);
  console.log(`Flash Loan:       ${hre.ethers.formatUnits(FLASH_LOAN_AMOUNT, 18)} DAI`);
  console.log(`Contract Balance: ${hre.ethers.formatUnits(contractDaiBalance, 18)} DAI`);
  console.log("━".repeat(70));
  console.log();

  if (contractDaiBalance < parseUnits("0.001", 18)) {
    console.log("⚠️  Warning: Low contract balance for premium payment");
    console.log("   Consider funding the contract with more DAI\n");
  }

  // Encode arbitrage parameters
  const arbitrageParams = {
    tokenA: DAI_ADDRESS,           // Borrow and return DAI
    tokenB: USDC_ADDRESS,          // Intermediate token
    dexBuy: UNISWAP_V2_ROUTER,     // Buy USDC on V2
    dexSell: UNISWAP_V3_ROUTER,    // Sell USDC on V3
    feeBuy: 0,                     // V2 doesn't use fee tiers
    feeSell: 3000,                 // V3 0.3% fee tier
    minProfit: 0,                  // Accept any profit for testing
    isV3Buy: false,                // V2 for buy
    isV3Sell: true                 // V3 for sell
  };

  console.log("📦 Encoding arbitrage parameters...");
  const encodedParams = hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address,address,address,address,uint24,uint24,uint256,bool,bool)"],
    [[
      arbitrageParams.tokenA,
      arbitrageParams.tokenB,
      arbitrageParams.dexBuy,
      arbitrageParams.dexSell,
      arbitrageParams.feeBuy,
      arbitrageParams.feeSell,
      arbitrageParams.minProfit,
      arbitrageParams.isV3Buy,
      arbitrageParams.isV3Sell
    ]]
  );

  console.log("✅ Parameters encoded\n");

  try {
    console.log("⏳ Executing flash loan arbitrage...");
    console.log("   This will:");
    console.log("   1. 🏦 Borrow 0.0005 DAI from Aave V3");
    console.log("   2. 💱 Swap DAI -> USDC on Uniswap V2");
    console.log("   3. 💱 Swap USDC -> DAI on Uniswap V3");
    console.log("   4. 💸 Repay flash loan + premium");
    console.log("   5. 💰 Keep profit (if any)\n");

    const tx = await flashLoanContract.requestFlashLoan(
      DAI_ADDRESS,
      FLASH_LOAN_AMOUNT,
      encodedParams,
      { gasLimit: 1000000 } // Higher gas limit for complex operations
    );

    console.log(`📤 Transaction sent: ${tx.hash}`);
    console.log("⏳ Waiting for confirmation...\n");

    const receipt = await tx.wait();

    if (receipt.status === 1) {
      console.log("🎉 ARBITRAGE EXECUTED SUCCESSFULLY! 🎉\n");
      console.log("📋 Transaction Details:");
      console.log("━".repeat(70));
      console.log(`Status:           ✅ Success`);
      console.log(`Block:            ${receipt.blockNumber}`);
      console.log(`Gas Used:         ${receipt.gasUsed.toString()}`);
      console.log(`Transaction Hash: ${receipt.hash}`);
      console.log("━".repeat(70));
      console.log();

      // Parse events
      console.log("📊 Events:");
      for (const log of receipt.logs) {
        try {
          const parsed = flashLoanContract.interface.parseLog(log);
          if (parsed) {
            console.log(`   - ${parsed.name}`);
            if (parsed.name === "ArbitrageExecuted") {
              const profit = parsed.args[4];
              console.log(`     💰 Profit: ${hre.ethers.formatUnits(profit, 18)} DAI`);
            }
          }
        } catch (e) {
          // Skip unparseable logs
        }
      }
      console.log();

      console.log(`🔍 View on Etherscan:`);
      console.log(`   https://sepolia.etherscan.io/tx/${receipt.hash}\n`);

      // Check final contract balance
      const finalBalance = await daiContract.balanceOf(FLASH_LOAN_CONTRACT);
      console.log(`💰 Final contract balance: ${hre.ethers.formatUnits(finalBalance, 18)} DAI`);

      const balanceChange = finalBalance - contractDaiBalance;
      if (balanceChange > 0n) {
        console.log(`✨ Profit added to contract: +${hre.ethers.formatUnits(balanceChange, 18)} DAI`);
      } else if (balanceChange < 0n) {
        console.log(`📉 Loss (premium paid): ${hre.ethers.formatUnits(balanceChange, 18)} DAI`);
      }

    } else {
      console.error("❌ Transaction failed");
    }

  } catch (error) {
    console.error("❌ Arbitrage Failed!\n");
    console.error("Error:", error.message);

    if (error.message.includes("Unprofitable arbitrage")) {
      console.error("\n💡 The arbitrage was not profitable");
      console.error("   This is expected if there's no price difference between DEXes");
    } else if (error.message.includes("Insufficient funds")) {
      console.error("\n💡 Contract doesn't have enough DAI to repay flash loan");
      console.error("   Fund the contract first: npx hardhat run scripts/fund-contract.js --network sepolia");
    } else if (error.message.includes("INSUFFICIENT_LIQUIDITY")) {
      console.error("\n💡 Not enough liquidity in the pool");
      console.error("   Try a smaller amount or different token pair");
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
