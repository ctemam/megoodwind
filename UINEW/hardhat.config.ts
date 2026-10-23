import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      forking: {
        url: process.env.NEXT_PUBLIC_ETH_RPC_URL || "", // Fork mainnet for realistic arbitrage testing
        enabled: true,
        blockNumber: undefined, // Use latest block
      },
      chainId: 31337, // Hardhat's default chain ID
    },
    sepolia: {
      url: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    mainnet: {
      url: process.env.NEXT_PUBLIC_ETH_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 1,
    },
  },
  
  // etherscan: {
  //   apiKey: process.env.ETHERSCAN_API_KEY || "",
  // },
};

export default config;
