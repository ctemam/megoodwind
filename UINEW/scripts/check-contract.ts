import hre from "hardhat";

async function main() {
  const contractAddress = "0xa40E009b306B3b4f27374f6e833291DaAeC88cc6";
  const code = await hre.ethers.provider.getCode(contractAddress);
  
  if (code === "0x") {
    console.log("❌ Contract NOT found at", contractAddress);
    console.log("💡 Deploy with: npx hardhat run scripts/deploy-fork.ts --network hardhat");
  } else {
    console.log("✅ Contract EXISTS at", contractAddress);
    console.log("Code length:", code.length, "bytes");
  }
}

main().catch(console.error);

