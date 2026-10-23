import hre from "hardhat";

/**
 * Deploy FlashLoanArbitrage to Hardhat fork
 * This allows testing arbitrage on a forked mainnet
 */
async function main() {
  console.log("🚀 Deploying FlashLoanArbitrage contract to Hardhat fork...\n");

  // Mainnet Aave V3 AddressesProvider
  const AAVE_ADDRESSES_PROVIDER_MAINNET = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e";

  const [deployer] = await hre.ethers.getSigners();
  console.log("📍 Deploying from account:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("💰 Account balance:", hre.ethers.formatEther(balance), "ETH\n");

  // Deploy the contract
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanArbitrage = await FlashLoanArbitrage.deploy(AAVE_ADDRESSES_PROVIDER_MAINNET);

  await flashLoanArbitrage.waitForDeployment();

  const contractAddress = await flashLoanArbitrage.getAddress();
  console.log("✅ FlashLoanArbitrage deployed to:", contractAddress);

  // Verify the pool was set correctly
  const poolAddress = await flashLoanArbitrage.POOL();
  console.log("✅ Aave Pool Address:", poolAddress);

  const ownerAddress = await flashLoanArbitrage.owner();
  console.log("✅ Contract Owner:", ownerAddress);

  console.log("\n📝 Contract deployment summary:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Contract Address:", contractAddress);
  console.log("Network: Hardhat Fork (Mainnet)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  console.log("💡 Add this to your .env.local:");
  console.log(`NEXT_PUBLIC_CONTRACT_ADDRESS=${contractAddress}\n`);

  return contractAddress;
}

main()
  .then((address) => {
    console.log("✅ Deployment complete!");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

