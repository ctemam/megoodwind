const hre = require("hardhat");
const { parseUnits } = require("ethers");

async function main() {
  console.log("💰 Funding New Contract...\n");

  const NEW_FLASH_LOAN_CONTRACT = "0x0F5D405A38B647DbC2C1B1F175E5e491330677a9";
  const DAI_ADDRESS = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";

  const [signer] = await hre.ethers.getSigners();
  console.log(`📝 Using account: ${signer.address}\n`);

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
  ];

  const daiContract = new hre.ethers.Contract(DAI_ADDRESS, ERC20_ABI, signer);

  // Check DAI balance
  const daiBalance = await daiContract.balanceOf(signer.address);
  console.log(`💵 Your DAI balance: ${hre.ethers.formatUnits(daiBalance, 18)} DAI\n`);

  if (daiBalance === 0n) {
    console.log("❌ No DAI balance found!");
    process.exit(1);
  }

  // Transfer 2 DAI to new contract
  const amountToTransfer = parseUnits("2", 18);

  console.log(`📤 Transferring 2 DAI to new contract...`);
  console.log(`   From: ${signer.address}`);
  console.log(`   To:   ${NEW_FLASH_LOAN_CONTRACT}\n`);

  try {
    const tx = await daiContract.transfer(NEW_FLASH_LOAN_CONTRACT, amountToTransfer);
    console.log(`⏳ Transaction sent: ${tx.hash}`);
    await tx.wait();

    const newBalance = await daiContract.balanceOf(NEW_FLASH_LOAN_CONTRACT);
    console.log(`\n✅ Transfer successful!`);
    console.log(`💰 New contract balance: ${hre.ethers.formatUnits(newBalance, 18)} DAI\n`);

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
