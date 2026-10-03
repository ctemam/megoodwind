// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BscFlashArb.sol";
import "../src/StateReader.sol";

contract DeployBsc is Script {
    // BSC mainnet tokens
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address constant ETH  = 0x2170Ed0880ac9A755fd29B2688956BD959F933F8;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        // PancakeSwap Infinity / V4-style PoolManager on BSC — confirm against
        // the protocol docs before broadcast; not hardcoded so a wrong value
        // can never be baked into the script.
        address poolManager = vm.envAddress("POOL_MANAGER");

        vm.startBroadcast(deployerKey);

        address[] memory tokens = new address[](5);
        tokens[0] = WBNB;
        tokens[1] = USDT;
        tokens[2] = USDC;
        tokens[3] = BUSD;
        tokens[4] = ETH;

        BscFlashArb arb = new BscFlashArb(
            vm.envOr("OWNER_ADDRESS", vm.addr(deployerKey)),
            poolManager,
            5 gwei,     // maxGasPrice — BSC blocks are cheap
            0,          // minProfitBps — accept any profit initially
            tokens
        );

        StateReader reader = new StateReader();

        console.log("BscFlashArb deployed at:", address(arb));
        console.log("StateReader deployed at:", address(reader));
        console.log("Owner:", arb.OWNER());

        vm.stopBroadcast();
    }
}
