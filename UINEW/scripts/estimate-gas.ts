import hre from "hardhat";

/**
 * Estimate deployment gas cost without actually deploying
 * Run: npx hardhat run scripts/estimate-gas.ts --network mainnet
 */
async function main() {
  console.log("📊 Estimating FlashLoanArbitrage deployment gas cost...\n");

  // Mainnet Addresses
  const AAVE_ADDRESSES_PROVIDER_MAINNET = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e";
  const BALANCER_VAULT_MAINNET = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

  const [deployer] = await hre.ethers.getSigners();
  console.log("📍 Estimating from account:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("💰 Current balance:", hre.ethers.formatEther(balance), "ETH\n");

  // Get current mainnet gas price
  const feeData = await hre.ethers.provider.getFeeData();

  const baseFeeGwei = feeData.maxFeePerGas ? Number(feeData.maxFeePerGas) / 1e9 : 0;
  const priorityFeeGwei = feeData.maxPriorityFeePerGas ? Number(feeData.maxPriorityFeePerGas) / 1e9 : 0;
  const gasPriceGwei = feeData.gasPrice ? Number(feeData.gasPrice) / 1e9 : 0;

  console.log("⛽ Current Gas Prices:");
  console.log("  Base Fee:", baseFeeGwei.toFixed(2), "Gwei");
  console.log("  Priority Fee:", priorityFeeGwei.toFixed(2), "Gwei");
  console.log("  Total (Legacy):", gasPriceGwei.toFixed(2), "Gwei\n");

  // Get contract factory
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");

  // Get deployment transaction data
  const deploymentData = FlashLoanArbitrage.getDeployTransaction(
    AAVE_ADDRESSES_PROVIDER_MAINNET,
    BALANCER_VAULT_MAINNET
  );

  // Estimate gas for deployment
  const estimatedGas = await hre.ethers.provider.estimateGas({
    data: deploymentData.data,
    from: deployer.address,
  });

  console.log("📊 Gas Estimation:");
  console.log("  Estimated gas units:", estimatedGas.toString(), "gas\n");

  // Calculate costs at different gas prices
  console.log("💵 Estimated Deployment Cost:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const scenarios = [
    { name: "Low (5 Gwei)", gasPrice: 5 },
    { name: "Normal (10 Gwei)", gasPrice: 10 },
    { name: "Medium (20 Gwei)", gasPrice: 20 },
    { name: "High (30 Gwei)", gasPrice: 30 },
    { name: "Current", gasPrice: gasPriceGwei },
  ];

  const ethPrices = [2500, 3000, 3500, 4000];

  for (const scenario of scenarios) {
    const gasCostWei = estimatedGas * BigInt(Math.floor(scenario.gasPrice * 1e9));
    const gasCostEth = Number(gasCostWei) / 1e18;

    console.log(`\n${scenario.name}:`);
    console.log(`  Gas cost: ${gasCostEth.toFixed(6)} ETH`);

    for (const ethPrice of ethPrices) {
      const gasCostUsd = gasCostEth * ethPrice;
      console.log(`    @ $${ethPrice}/ETH: $${gasCostUsd.toFixed(2)}`);
    }
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Bytecode size check
  const bytecode = FlashLoanArbitrage.bytecode;
  const bytecodeSize = (bytecode.length - 2) / 2; // Remove 0x and divide by 2
  const maxSize = 24576; // 24KB limit
  const sizePercentage = (bytecodeSize / maxSize * 100).toFixed(2);

  console.log("📦 Contract Size:");
  console.log(`  Bytecode size: ${bytecodeSize.toLocaleString()} bytes`);
  console.log(`  Size limit: ${maxSize.toLocaleString()} bytes`);
  console.log(`  Usage: ${sizePercentage}%`);

  if (bytecodeSize > maxSize) {
    console.log("  ❌ WARNING: Contract exceeds size limit!");
  } else {
    console.log(`  ✅ OK (${(maxSize - bytecodeSize).toLocaleString()} bytes remaining)`);
  }

  console.log("\n✅ Estimation complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
