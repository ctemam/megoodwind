// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AllBrightExecutor} from "../contracts/AllBrightExecutor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC20 is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;
    string public name = "MCK"; string public symbol = "MCK"; uint8 public decimals = 18;

    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function transfer(address to, uint256 a) external override returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function approve(address s, uint256 a) external override returns (bool) {
        allowance[msg.sender][s] = a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external override returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/// Mock Balancer Vault — pushes tokens then calls receiveFlashLoan.
contract MockVault {
    function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData) external {
        for (uint256 i; i < tokens.length; i++) MockERC20(tokens[i]).mint(recipient, amounts[i]);
        uint256[] memory fees = new uint256[](tokens.length);
        IFlashRecipient(recipient).receiveFlashLoan(tokens, amounts, fees, userData);
    }
}
interface IFlashRecipient {
    function receiveFlashLoan(address[] memory, uint256[] memory, uint256[] memory, bytes memory) external;
}

/// Mock V2 pair — fixed-rate 1:1.01 swap to simulate a profitable leg.
contract MockPair {
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    constructor(address t0, address t1) { token0 = IERC20(t0); token1 = IERC20(t1); }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (uint112(token0.balanceOf(address(this))), uint112(token1.balanceOf(address(this))), 0);
    }
    function swap(uint256 a0, uint256 a1, address to, bytes calldata) external {
        if (a0 > 0) token0.transfer(to, a0);
        if (a1 > 0) token1.transfer(to, a1);
    }
}

contract AllBrightExecutorTest is Test {
    AllBrightExecutor exec;
    MockVault vault;
    MockERC20 a;
    MockERC20 b;
    MockPair pairAB;
    MockPair pairBA;
    address owner = address(this);

    function setUp() public {
        vault = new MockVault();
        exec = new AllBrightExecutor(address(vault), address(0));
        a = new MockERC20();
        b = new MockERC20();
        pairAB = new MockPair(address(a), address(b));
        pairBA = new MockPair(address(b), address(a));
        // seed both pairs with deep reserves
        a.mint(address(pairAB), 1_000_000 ether); b.mint(address(pairAB), 1_000_000 ether);
        b.mint(address(pairBA), 1_000_000 ether); a.mint(address(pairBA), 2_000_000 ether); // B->A pays 2x
    }

    function _plan(uint256 amount, uint256 minOut, uint256 minProfit) internal view returns (bytes memory) {
        AllBrightExecutor.Hop[] memory hops = new AllBrightExecutor.Hop[](2);
        hops[0] = AllBrightExecutor.Hop(AllBrightExecutor.DexKind.V2_PAIR, address(pairAB), address(a), address(b), 0, 30);
        hops[1] = AllBrightExecutor.Hop(AllBrightExecutor.DexKind.V2_PAIR, address(pairBA), address(b), address(a), 0, 30);
        return abi.encode(AllBrightExecutor.ArbPlan(
            AllBrightExecutor.FlashSource.BALANCER, address(a), amount, hops, minOut, minProfit
        ));
    }

    function test_ownerGate() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        exec.exec(_plan(100 ether, 0, 0));
    }

    function test_balancerCycleProfits() public {
        // A->B at 1:1 less fee, B->A at ~2:1 less fee -> profit in A
        exec.exec(_plan(100 ether, 0, 1 ether));
        uint256 bal = a.balanceOf(address(exec));
        assertGt(bal, 1 ether, "cycle should leave profit in token A");
    }

    function test_minOutRevertsDecayedSpread() public {
        // last-hop minOut set above achievable output -> whole tx reverts
        vm.expectRevert();
        exec.exec(_plan(100 ether, 1_000_000 ether, 0));
    }

    function test_profitFloor() public {
        vm.expectRevert();
        exec.exec(_plan(100 ether, 0, 10_000 ether)); // floor above achievable
    }

    function test_sweep() public {
        exec.exec(_plan(100 ether, 0, 0));
        uint256 bal = a.balanceOf(address(exec));
        exec.sweep(address(a), owner, bal);
        assertEq(a.balanceOf(owner), bal);
    }
}
