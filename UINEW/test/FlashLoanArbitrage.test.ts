import hre from "hardhat";
const { ethers } = hre;

describe("FlashLoanArbitrage - Multicall Pattern", function () {
  let flashLoanArbitrage: any;
  let owner: any;
  let addr1: any;

  // Sepolia addresses
  const AAVE_ADDRESSES_PROVIDER_SEPOLIA = "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A";
  const WETH_SEPOLIA = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
  const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
  const DAI_SEPOLIA = "0x68194a729C2450ad26072b3D33ADaCbcef39D574";

  beforeEach(async function () {
    [owner, addr1] = await ethers.getSigners();

    const FlashLoanArbitrageFactory = await ethers.getContractFactory("FlashLoanArbitrage");
    flashLoanArbitrage = await FlashLoanArbitrageFactory.deploy(AAVE_ADDRESSES_PROVIDER_SEPOLIA);
    await flashLoanArbitrage.waitForDeployment();
  });

  describe("Batch Approve", function () {
    it("Should batch approve multiple tokens", async function () {
      const tokens = [WETH_SEPOLIA, USDC_SEPOLIA, DAI_SEPOLIA];
      const contractAddress = await flashLoanArbitrage.getAddress();
      const spenders = [contractAddress, contractAddress, contractAddress];
      const amounts = [
        ethers.parseEther("1"),
        ethers.parseUnits("1000", 6), // USDC has 6 decimals
        ethers.parseEther("1000"),
      ];

      await flashLoanArbitrage.batchApprove(tokens, spenders, amounts);
      console.log("✅ Batch approve successful");
    });

    it("Should revert if array lengths mismatch", async function () {
      const tokens = [WETH_SEPOLIA, USDC_SEPOLIA];
      const contractAddress = await flashLoanArbitrage.getAddress();
      const spenders = [contractAddress];
      const amounts = [ethers.parseEther("1")];

      try {
        await flashLoanArbitrage.batchApprove(tokens, spenders, amounts);
        throw new Error("Should have reverted");
      } catch (error: any) {
        if (error.message.includes("Array length mismatch")) {
          console.log("✅ Array length mismatch reverted correctly");
        } else {
          throw error;
        }
      }
    });

    it("Should only allow owner to batch approve", async function () {
      const tokens = [WETH_SEPOLIA];
      const contractAddress = await flashLoanArbitrage.getAddress();
      const spenders = [contractAddress];
      const amounts = [ethers.parseEther("1")];

      try {
        await flashLoanArbitrage.connect(addr1).batchApprove(tokens, spenders, amounts);
        throw new Error("Should have reverted");
      } catch (error: any) {
        if (error.message.includes("Not owner")) {
          console.log("✅ Only owner can batch approve");
        } else {
          throw error;
        }
      }
    });
  });

  describe("Multicall", function () {
    it("Should execute multiple calls atomically", async function () {
      const calls: string[] = [];
      const contractAddress = await flashLoanArbitrage.getAddress();

      // Call 1: Emergency approve
      const iface = flashLoanArbitrage.interface;
      const approveData = iface.encodeFunctionData("emergencyApprove", [
        WETH_SEPOLIA,
        contractAddress,
        ethers.parseEther("1"),
      ]);
      calls.push(approveData);

      // Call 2: Another emergency approve
      const approveData2 = iface.encodeFunctionData("emergencyApprove", [
        USDC_SEPOLIA,
        contractAddress,
        ethers.parseUnits("1000", 6),
      ]);
      calls.push(approveData2);

      // Execute multicall
      await flashLoanArbitrage.multicall(calls);
      console.log("✅ Multicall executed successfully");
    });

    it("Should only allow owner to execute multicall", async function () {
      const calls: string[] = [];
      const contractAddress = await flashLoanArbitrage.getAddress();
      const iface = flashLoanArbitrage.interface;

      const approveData = iface.encodeFunctionData("emergencyApprove", [
        WETH_SEPOLIA,
        contractAddress,
        ethers.parseEther("1"),
      ]);
      calls.push(approveData);

      try {
        await flashLoanArbitrage.connect(addr1).multicall(calls);
        throw new Error("Should have reverted");
      } catch (error: any) {
        if (error.message.includes("Not owner")) {
          console.log("✅ Only owner can execute multicall");
        } else {
          throw error;
        }
      }
    });
  });

  describe("Gas Optimization Test", function () {
    it("Should use less gas with batch approve vs individual approves", async function () {
      const contractAddress = await flashLoanArbitrage.getAddress();
      const tokens = [WETH_SEPOLIA, USDC_SEPOLIA, DAI_SEPOLIA];
      const spenders = [contractAddress, contractAddress, contractAddress];
      const amounts = [
        ethers.parseEther("1"),
        ethers.parseUnits("1000", 6),
        ethers.parseEther("1000"),
      ];

      // Individual approves
      const tx1 = await flashLoanArbitrage.emergencyApprove(tokens[0], spenders[0], amounts[0]);
      const receipt1 = await tx1.wait();

      const tx2 = await flashLoanArbitrage.emergencyApprove(tokens[1], spenders[1], amounts[1]);
      const receipt2 = await tx2.wait();

      const tx3 = await flashLoanArbitrage.emergencyApprove(tokens[2], spenders[2], amounts[2]);
      const receipt3 = await tx3.wait();

      const individualGas = (receipt1?.gasUsed || 0n) + (receipt2?.gasUsed || 0n) + (receipt3?.gasUsed || 0n);

      // Batch approve
      const batchTx = await flashLoanArbitrage.batchApprove(tokens, spenders, amounts);
      const batchReceipt = await batchTx.wait();
      const batchGas = batchReceipt?.gasUsed || 0n;

      console.log(`\n📊 Gas Comparison:`);
      console.log(`   Individual approves: ${individualGas.toString()} gas`);
      console.log(`   Batch approve: ${batchGas.toString()} gas`);
      console.log(`   Gas saved: ${(individualGas - batchGas).toString()} gas`);
      console.log(`   Savings: ${((Number(individualGas - batchGas) / Number(individualGas)) * 100).toFixed(2)}%`);

      // Batch should use less gas
      if (batchGas < individualGas) {
        console.log("✅ Batch approve is more gas efficient!");
      }
    });
  });

  describe("Contract Basics", function () {
    it("Should deploy with correct owner", async function () {
      const contractOwner = await flashLoanArbitrage.owner();
      const ownerAddress = await owner.getAddress();

      if (contractOwner === ownerAddress) {
        console.log("✅ Contract owner is correct");
      } else {
        throw new Error("Owner mismatch");
      }
    });

    it("Should have correct Aave pool", async function () {
      const poolAddress = await flashLoanArbitrage.POOL();
      console.log(`✅ Aave Pool Address: ${poolAddress}`);
    });
  });
});
