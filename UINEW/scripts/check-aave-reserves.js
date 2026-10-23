const hre = require("hardhat");

async function main() {
  console.log("🔍 Checking Aave V3 Sepolia Reserves...\n");

  const AAVE_POOL_ADDRESSES_PROVIDER = "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A";
  const AAVE_POOL = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";

  // Common Sepolia test tokens
  const tokens = {
    "WETH": "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    "DAI (Aave V3)": "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357",
    "USDC": "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
    "LINK": "0x779877A7B0D9E8603169DdbD7836e478b4624789",
  };

  const POOL_ABI = [
    "function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  ];

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ];

  const pool = new hre.ethers.Contract(AAVE_POOL, POOL_ABI, hre.ethers.provider);

  console.log("📊 Aave V3 Sepolia Reserve Information:");
  console.log("━".repeat(80));
  console.log(`Pool Address: ${AAVE_POOL}\n`);

  for (const [name, address] of Object.entries(tokens)) {
    try {
      console.log(`🔹 ${name}`);
      console.log(`   Token Address: ${address}`);

      const reserveData = await pool.getReserveData(address);
      const aTokenAddress = reserveData[8];

      if (aTokenAddress === "0x0000000000000000000000000000000000000000") {
        console.log(`   ❌ NOT LISTED on Aave V3 Sepolia`);
      } else {
        console.log(`   ✅ Listed on Aave V3`);
        console.log(`   aToken: ${aTokenAddress}`);

        // Check liquidity
        const tokenContract = new hre.ethers.Contract(address, ERC20_ABI, hre.ethers.provider);
        const decimals = await tokenContract.decimals();
        const liquidity = await tokenContract.balanceOf(aTokenAddress);

        console.log(`   Liquidity: ${hre.ethers.formatUnits(liquidity, decimals)} tokens`);

        if (liquidity > 0n) {
          console.log(`   💡 Flash loan possible: YES`);
        } else {
          console.log(`   ⚠️  Flash loan possible: NO (no liquidity)`);
        }
      }

    } catch (error) {
      console.log(`   ❌ Error checking reserve: ${error.message}`);
    }
    console.log();
  }

  console.log("━".repeat(80));
  console.log("\n💡 Tips:");
  console.log("   - Only tokens with ✅ and liquidity > 0 support flash loans");
  console.log("   - Use tokens with high liquidity for testing");
  console.log("   - Get test tokens from: https://staging.aave.com/faucet/\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
