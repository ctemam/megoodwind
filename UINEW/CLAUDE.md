# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Flash Loan Arbitrage Scanner is a real-time arbitrage opportunity detection system for Ethereum mainnet. The project uses flash loans to execute profitable arbitrage trades across multiple DEX protocols without requiring upfront capital.

**Tech Stack:**
- Frontend: Next.js 15 with React 19 and TypeScript
- Styling: Tailwind CSS
- Web3: viem + wagmi for blockchain interactions
- RPC: Alchemy for Ethereum mainnet
- Build Tool: Turbopack (via Next.js)

**Supported Networks:**
- Ethereum Mainnet (Chain ID: 1)
- Sepolia Testnet (Chain ID: 11155111)

## Architecture

### Directory Structure

```
/app                    # Next.js App Router pages and layouts
  /api                  # API routes for backend logic
/components             # React components
  /monitors             # Arbitrage-specific UI components
/lib                    # Core application logic
  /hooks                # React hooks (e.g., useArbitrage)
  /monitors             # Arbitrage scanners and executors
  /utils                # Utility functions
/types                  # TypeScript type definitions
```

### Key Concepts

**DEX Protocols** (defined in `types/monitor.ts`):
- `UNISWAP_V2`: Uniswap V2 protocol
- `UNISWAP_V3`: Uniswap V3 protocol
- `SUSHISWAP`: Sushiswap protocol
- `BALANCER`: Balancer protocol
- `CURVE`: Curve protocol

**Flash Loan Providers**:
- `AAVE_V3`: Aave V3 flash loans (default)
- `UNISWAP_V3`: Uniswap V3 flash swaps
- `BALANCER`: Balancer flash loans

**ArbitrageOpportunity**: Core data structure representing a profitable arbitrage:
- Token pair information
- Buy/sell prices across different DEXes
- Estimated profit after gas costs
- Flash loan protocol to use

**ArbitrageState**: Central state management including:
- Scanning status
- List of found opportunities
- Configuration (min profit, max gas price)
- Statistics (total scanned, found opportunities, total profit)

### Component Architecture

- `useArbitrage` hook: Manages arbitrage scanning state and execution
- `ArbitrageControl`: Control panel for starting/stopping scanner and viewing settings
- `OpportunityList`: Displays found arbitrage opportunities with execute buttons
- Main page (`app/page.tsx`): Integrates all components

### Strategy

The system implements a multi-DEX flash loan arbitrage strategy:

1. **Price Scanning**: Continuously monitors prices across configured DEXes
2. **Opportunity Detection**: Identifies profitable price differences between DEXes
3. **Profitability Calculation**: Estimates profit after gas costs
4. **Flash Loan Execution**: Uses flash loans to execute arbitrage without capital
5. **Atomic Transaction**: Entire trade (borrow, buy, sell, repay) happens in one transaction

## Development Commands

### Setup
```bash
npm install              # Install dependencies
```

### Development
```bash
npm run dev             # Start development server with Turbopack
                        # Runs on http://localhost:3000
```

### Build & Production
```bash
npm run build           # Build for production
npm start               # Start production server
```

### Code Quality
```bash
npm run lint            # Run ESLint
```

## Environment Variables

Create a `.env.local` file with your Alchemy API key:

```env
NEXT_PUBLIC_ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY
```

Get your Alchemy API key from: https://www.alchemy.com/

## Smart Contract Addresses (Ethereum Mainnet)

**DEX Routers:**
- Uniswap V2: `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`
- Uniswap V3: `0xE592427A0AEce92De3Edee1F18E0157C05861564`
- Sushiswap: `0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F`

**Flash Loan Providers:**
- Aave V3: `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`
- Balancer: `0xBA12222222228d8Ba445958a75a0704d566BF2C8`

**Major Tokens (Mainnet):**
- WETH: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`
- USDC: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- USDT: `0xdAC17F958D2ee523a2206206994597C13D831ec7`

**Major Tokens (Sepolia):**
- WETH: `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9`
- USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- DAI: `0x68194a729C2450ad26072b3D33ADaCbcef39D574`
- LINK: `0x779877A7B0D9E8603169DdbD7836e478b4624789`

## Smart Contracts

### FlashLoanArbitrage Contract

**Sepolia Testnet:**
- Contract Address: `0x950A14AEB93610AE729A3DF265f89F9280839dEb`
- Etherscan: https://sepolia.etherscan.io/address/0x950A14AEB93610AE729A3DF265f89F9280839dEb
- Deployed: 2025-12-13 (Upgraded with MEV optimizations)

**Previous Deployment:**
- Old Address: `0x42859fff18EcB08Eafa48BC65d44899e1D6F02E8` (2025-01-12)

**Features:**
- Aave V3 Flash Loan integration
- Owner-only access control
- Multicall pattern for atomic batch operations
- Gas-optimized batch approvals (62.61% gas savings)
- Smart allowance management with infinite approvals
- Slippage protection with configurable BPS
- Withdrawal functions
- Event logging

**Key Functions:**
- `requestFlashLoan(address asset, uint256 amount)`: Request a flash loan from Aave V3
- `executeArbitrageInternal(...)`: Execute arbitrage between DEXes with slippage protection
- `batchApprove(address[] tokens, address[] spenders, uint256[] amounts)`: Batch approve multiple tokens
- `multicall(bytes[] data)`: Execute multiple calls atomically via delegatecall
- `withdraw(address token, uint256 amount)`: Withdraw tokens from contract
- `withdrawAll(address token)`: Withdraw all tokens of a specific type
- `emergencyApprove(address token, address spender, uint256 amount)`: Emergency token approval

## Implementation Notes

- All components use `"use client"` directive for client-side interactivity
- Type safety is enforced throughout with TypeScript strict mode
- The scanner maintains up to 50 recent opportunities in memory
- Gas cost estimation is crucial for profitability calculations
- Transactions must be atomic to avoid risk
