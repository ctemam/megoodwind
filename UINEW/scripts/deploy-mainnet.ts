import hre from "hardhat";

async function main() {
  console.log("🚀 Deploying FlashLoanArbitrage contract to MAINNET...\n");
  console.log("⚠️  WARNING: This will deploy to ETHEREUM MAINNET");
  console.log("⚠️  Make sure you have reviewed the contract thoroughly\n");

  // Mainnet Addresses
  const AAVE_ADDRESSES_PROVIDER_MAINNET = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e";
  const BALANCER_VAULT_MAINNET = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

  const [deployer] = await hre.ethers.getSigners();
  console.log("📍 Deploying from account:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("💰 Account balance:", hre.ethers.formatEther(balance), "ETH\n");

  // Get current gas price
  const feeData = await hre.ethers.provider.getFeeData();
  const gasPriceGwei = Number(feeData.gasPrice) / 1e9;
  console.log("⛽ Current gas price:", gasPriceGwei.toFixed(2), "Gwei\n");

  // Estimate deployment gas (approximate)
  const estimatedGas = 3300000; // Approximate gas for contract deployment

  console.log("📊 Gas Estimation:");
  console.log("  Gas units:", estimatedGas.toString());

  const gasCostWei = BigInt(estimatedGas) * (feeData.gasPrice || 0n);
  const gasCostEth = Number(gasCostWei) / 1e18;

  console.log("  Gas cost:", gasCostEth.toFixed(6), "ETH");

  // Assume ETH = $3,500 for USD estimate (update with actual price)
  const ethPriceUsd = 3500;
  const gasCostUsd = gasCostEth * ethPriceUsd;
  console.log("  Gas cost (USD):", "$" + gasCostUsd.toFixed(2), "(@ $" + ethPriceUsd + "/ETH)");

  const balanceEth = Number(balance) / 1e18;
  if (gasCostEth > balanceEth) {
    console.error("\n❌ Insufficient balance for deployment!");
    console.error("   Required:", gasCostEth.toFixed(6), "ETH");
    console.error("   Available:", hre.ethers.formatEther(balance), "ETH");
    process.exit(1);
  }

  console.log("\n⏳ Waiting 10 seconds before deployment...");
  console.log("   Press Ctrl+C to cancel\n");
  await new Promise(resolve => setTimeout(resolve, 10000));

  console.log("🔨 Deploying contract...\n");

  // Deploy the contract
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanArbitrage = await FlashLoanArbitrage.deploy(
    AAVE_ADDRESSES_PROVIDER_MAINNET,
    BALANCER_VAULT_MAINNET
  );

  await flashLoanArbitrage.waitForDeployment();

  const contractAddress = await flashLoanArbitrage.getAddress();
  console.log("✅ FlashLoanArbitrage deployed to:", contractAddress);

  // Verify the pool was set correctly
  const poolAddress = await flashLoanArbitrage.POOL();
  const balancerVault = await flashLoanArbitrage.BALANCER_VAULT();
  console.log("✅ Aave Pool Address:", poolAddress);
  console.log("✅ Balancer Vault Address:", balancerVault);

  const ownerAddress = await flashLoanArbitrage.owner();
  console.log("✅ Contract Owner:", ownerAddress);

  console.log("\n📝 Contract deployment summary:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Network: Ethereum Mainnet");
  console.log("Contract Address:", contractAddress);
  console.log("Etherscan:", `https://etherscan.io/address/${contractAddress}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  console.log("🔍 Contract Features:");
  console.log("  ✓ Aave V3 Flash Loans (0.09% fee)");
  console.log("  ✓ Balancer Flash Loans (0% fee)");
  console.log("  ✓ Uniswap V3 Flash Swaps (0.05% fee)");
  console.log("  ✓ Uniswap V2/V3 DEX routing");
  console.log("  ✓ Slippage protection");
  console.log("  ✓ Gas optimizations\n");

  console.log("⚠️  IMPORTANT NEXT STEPS:");
  console.log("1. Verify contract on Etherscan");
  console.log("2. Update .env.local with contract address:");
  console.log("   NEXT_PUBLIC_CONTRACT_ADDRESS=" + contractAddress);
  console.log("3. Test with small amounts first");
  console.log("4. Set up monitoring and alerts\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
