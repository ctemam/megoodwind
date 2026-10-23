const hre = require("hardhat");

async function main() {
  console.log("🔍 Checking Token Balances on Sepolia...\n");

  const [signer] = await hre.ethers.getSigners();
  console.log(`📝 Wallet Address: ${signer.address}\n`);

  // Check ETH balance
  const ethBalance = await hre.ethers.provider.getBalance(signer.address);
  console.log(`💰 ETH Balance: ${hre.ethers.formatEther(ethBalance)} ETH\n`);

  // Common Sepolia test token addresses
  const tokens = {
    "DAI (Aave V3)": "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357",
    "DAI (Old)": "0x68194a729C2450ad26072b3D33ADaCbcef39D574",
    "USDC (Aave V3)": "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
    "LINK": "0x779877A7B0D9E8603169DdbD7836e478b4624789",
    "WETH": "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
  };

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ];

  console.log("📊 Token Balances:");
  console.log("━".repeat(70));

  for (const [name, address] of Object.entries(tokens)) {
    try {
      const contract = new hre.ethers.Contract(address, ERC20_ABI, signer);
      const balance = await contract.balanceOf(signer.address);
      const decimals = await contract.decimals();
      const symbol = await contract.symbol();
      const formatted = hre.ethers.formatUnits(balance, decimals);

      if (balance > 0n) {
        console.log(`✅ ${name.padEnd(20)} ${formatted.padStart(15)} ${symbol}`);
        console.log(`   Address: ${address}`);
      } else {
        console.log(`❌ ${name.padEnd(20)} ${formatted.padStart(15)} ${symbol}`);
      }
    } catch (error) {
      console.log(`⚠️  ${name.padEnd(20)} - Error reading contract`);
    }
  }

  console.log("━".repeat(70));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
