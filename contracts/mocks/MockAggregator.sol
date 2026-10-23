// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
/// Fork-test only — replaced Chainlink feed code via anvil_setCode to push
/// a test position underwater. Never deployed to a live chain.
contract MockAggregator {
    int256 public answer;
    constructor(int256 a) { answer = a; }
    function latestAnswer() external view returns (int256) { return answer; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
    function decimals() external pure returns (uint8) { return 8; }
}
