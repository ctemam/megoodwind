const hre = require("hardhat");
const { parseUnits } = require("ethers");

async function main() {
  console.log("💰 Adding More DAI to Contract...\n");

  const FLASH_LOAN_CONTRACT = "0x42859fff18EcB08Eafa48BC65d44899e1D6F02E8";
  const DAI_ADDRESS = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";

  const [signer] = await hre.ethers.getSigners();

  // Add 1 more DAI (now total will be 2 DAI, enough for 100 DAI flash loan)
  const amountToTransfer = parseUnits("1", 18);

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
  ];

  const daiContract = new hre.ethers.Contract(DAI_ADDRESS, ERC20_ABI, signer);

  // Check current balance
  const currentBalance = await daiContract.balanceOf(FLASH_LOAN_CONTRACT);
  console.log(`Current contract balance: ${hre.ethers.formatUnits(currentBalance, 18)} DAI`);

  console.log(`\n📤 Transferring 1 more DAI to contract...`);

  try {
    const tx = await daiContract.transfer(FLASH_LOAN_CONTRACT, amountToTransfer);
    console.log(`⏳ Transaction sent: ${tx.hash}`);
    await tx.wait();

    const newBalance = await daiContract.balanceOf(FLASH_LOAN_CONTRACT);
    console.log(`\n✅ Transfer successful!`);
    console.log(`💰 New contract balance: ${hre.ethers.formatUnits(newBalance, 18)} DAI`);
    console.log(`\n✨ Now contract can handle flash loans up to:`);
    console.log(`   ~${Math.floor(parseFloat(hre.ethers.formatUnits(newBalance, 18)) / 0.0005)} DAI`);

  } catch (error) {
    console.error("❌ Transfer failed:", error.message);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
