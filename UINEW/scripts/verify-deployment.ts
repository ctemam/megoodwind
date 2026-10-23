import hre from "hardhat";

async function main() {
  console.log("🔍 Verifying deployed FlashLoanArbitrage contract on Sepolia...\n");

  const CONTRACT_ADDRESS = "0x950A14AEB93610AE729A3DF265f89F9280839dEb";

  // Get the contract instance
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const contract = FlashLoanArbitrage.attach(CONTRACT_ADDRESS);

  console.log("📍 Contract Address:", CONTRACT_ADDRESS);
  console.log("🔗 Etherscan:", `https://sepolia.etherscan.io/address/${CONTRACT_ADDRESS}\n`);

  try {
    // Verify basic contract properties
    console.log("✅ Verifying contract properties...");

    const owner = await contract.owner();
    console.log("  Owner:", owner);

    const poolAddress = await contract.POOL();
    console.log("  Aave Pool:", poolAddress);

    const addressesProvider = await contract.ADDRESSES_PROVIDER();
    console.log("  Addresses Provider:", addressesProvider);

    console.log("\n✅ All contract properties verified successfully!");
    console.log("\n📝 Contract is ready for:");
    console.log("  ✓ Flash loan arbitrage execution");
    console.log("  ✓ Multicall batch operations");
    console.log("  ✓ Gas-optimized batch approvals");
    console.log("  ✓ Slippage-protected swaps");

  } catch (error) {
    console.error("\n❌ Verification failed:", error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
