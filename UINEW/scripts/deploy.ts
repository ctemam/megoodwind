import hre from "hardhat";

async function main() {
  console.log("🚀 Deploying FlashLoanArbitrage contract to Sepolia...\n");

  // Sepolia Aave V3 AddressesProvider
  const AAVE_ADDRESSES_PROVIDER_SEPOLIA = "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A";

  const [deployer] = await hre.ethers.getSigners();
  console.log("📍 Deploying from account:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("💰 Account balance:", hre.ethers.formatEther(balance), "ETH\n");

  // Deploy the contract
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanArbitrage = await FlashLoanArbitrage.deploy(AAVE_ADDRESSES_PROVIDER_SEPOLIA);

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
  console.log("Etherscan:", `https://sepolia.etherscan.io/address/${contractAddress}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  console.log("🔍 New features in this deployment:");
  console.log("  ✓ Multicall pattern for atomic operations");
  console.log("  ✓ Batch approve for gas optimization");
  console.log("  ✓ Smart allowance management (_ensureAllowance)");
  console.log("  ✓ Slippage protection with configurable BPS");
  console.log("  ✓ Extended deadline (5 minutes) for swaps\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
