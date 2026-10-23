const hre = require("hardhat");

async function main() {
  console.log("🚀 Deploying FlashLoanArbitrage contract to Sepolia...\n");

  // Aave V3 Pool Addresses Provider on Sepolia
  const AAVE_V3_POOL_ADDRESSES_PROVIDER = "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A";

  // Get the contract factory
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");

  console.log("📝 Contract factory created");
  console.log(`📍 Using Aave V3 Pool Addresses Provider: ${AAVE_V3_POOL_ADDRESSES_PROVIDER}\n`);

  // Deploy the contract
  console.log("⏳ Deploying contract...");
  const flashLoanArbitrage = await FlashLoanArbitrage.deploy(AAVE_V3_POOL_ADDRESSES_PROVIDER);

  await flashLoanArbitrage.waitForDeployment();

  const contractAddress = await flashLoanArbitrage.getAddress();

  console.log("✅ Contract deployed successfully!\n");
  console.log("📋 Deployment Details:");
  console.log("━".repeat(60));
  console.log(`Contract Address:     ${contractAddress}`);
  console.log(`Network:              Sepolia Testnet`);
  console.log(`Chain ID:             11155111`);
  console.log(`Deployer:             ${(await hre.ethers.getSigners())[0].address}`);
  console.log("━".repeat(60));

  console.log("\n📝 Next Steps:");
  console.log("1. Verify contract on Etherscan:");
  console.log(`   npx hardhat verify --network sepolia ${contractAddress} ${AAVE_V3_POOL_ADDRESSES_PROVIDER}`);
  console.log("\n2. Add contract address to lib/config.ts");
  console.log("\n3. Test flash loan functionality");

  // Save deployment info to a file
  const fs = require("fs");
  const deploymentInfo = {
    network: "sepolia",
    chainId: 11155111,
    contractAddress: contractAddress,
    aavePoolAddressesProvider: AAVE_V3_POOL_ADDRESSES_PROVIDER,
    deployedAt: new Date().toISOString(),
    deployer: (await hre.ethers.getSigners())[0].address,
  };

  fs.writeFileSync(
    "deployment-sepolia.json",
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log("\n💾 Deployment info saved to deployment-sepolia.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
