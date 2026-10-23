import hre from "hardhat";

/**
 * Deploy FlashLoanArbitrage contract to Hardhat fork with Balancer support
 */
async function main() {
  console.log("🚀 Deploying FlashLoanArbitrage with Balancer support to Hardhat fork...\n");

  // Ethereum Mainnet addresses (used for forking)
  const AAVE_ADDRESSES_PROVIDER_MAINNET = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e"; // Corrected checksum
  const BALANCER_VAULT_MAINNET = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

  const [deployer] = await hre.ethers.getSigners();
  console.log("📍 Deploying from account:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("💰 Account balance:", hre.ethers.formatEther(balance), "ETH\n");

  // Get current gas price and set higher maxFeePerGas for fork
  const feeData = await hre.ethers.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas || hre.ethers.parseUnits("200", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || hre.ethers.parseUnits("2", "gwei");

  // Deploy FlashLoanArbitrage with Balancer support
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanArbitrage = await FlashLoanArbitrage.deploy(
    AAVE_ADDRESSES_PROVIDER_MAINNET,
    BALANCER_VAULT_MAINNET,
    {
      maxFeePerGas,
      maxPriorityFeePerGas,
    }
  );

  await flashLoanArbitrage.waitForDeployment();

  const contractAddress = await flashLoanArbitrage.getAddress();
  console.log("✅ FlashLoanArbitrage deployed to:", contractAddress);

  // Verify contract addresses
  console.log("\n📝 Contract configuration:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Contract Address:", contractAddress);
  console.log("Aave V3 Pool:", AAVE_ADDRESSES_PROVIDER_MAINNET);
  console.log("Balancer Vault:", BALANCER_VAULT_MAINNET);
  console.log("Network: Hardhat Fork (Mainnet)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  console.log("💡 Add this to your .env.local:");
  console.log(`NEXT_PUBLIC_CONTRACT_ADDRESS=${contractAddress}`);
  
  console.log("\n🎯 Flash Loan Protocols Available:");
  console.log("  1. Balancer (0% fee) - requestBalancerFlashLoan()");
  console.log("  2. Aave V3 (0.09% fee) - requestAaveFlashLoan()");
  console.log("  3. Uniswap V3 (0.05% fee) - requestUniswapV3FlashSwap()");

  console.log("\n✅ Deployment complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

