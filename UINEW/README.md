<div align="center">

# ⚡ Flash Loan Arbitrage Scanner

**Real-time cross-DEX arbitrage detection & atomic execution on Ethereum Mainnet**

*Zero capital required — powered by Aave V3 flash loans*

[![Next.js](https://img.shields.io/badge/Next.js-15-000000?style=flat-square&logo=next.js&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![viem](https://img.shields.io/badge/viem-2.x-FFC517?style=flat-square)](https://viem.sh/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](https://opensource.org/licenses/MIT)

</div>

---

## ✨ Highlights

- 🔍 **Real-time scanning** — Polls cross-DEX prices every 5 seconds for arbitrage opportunities
- ⚡ **Zero-capital execution** — Aave V3 flash loans eliminate upfront capital requirements
- 🧮 **Profit-aware** — Net profit calculation accounts for gas costs before execution
- 🔗 **Atomic by design** — All operations settle in a single transaction, or revert
- 📊 **Multi-source aggregation** — Cross-references 1inch, ParaSwap, and Uniswap V3 quotes
- 🎯 **Production-grade routing** — 1inch aggregator as primary price source for optimal paths

---

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Price Sources  │────▶│  Scanner Engine  │────▶│  Flash Loan TX  │
│ 1inch│ParaSwap  │     │  Δ price + gas   │     │   Aave V3 Pool  │
│  Uniswap V3/V2  │     │   profitability  │     │  Atomic Settle  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Supported Sources

| Category | Providers |
|----------|-----------|
| **Aggregators** | 1inch *(primary)* · ParaSwap *(backup)* |
| **Direct DEX** | Uniswap V3 · Uniswap V2 · SushiSwap |
| **Flash Loans** | Aave V3 *(default)* · Uniswap V3 · Balancer |

### Monitored Pairs

`WETH/USDC` · `WETH/USDT` · `WETH/DAI` · `WBTC/WETH`

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** `20+`
- **Alchemy API key** — [get one here](https://www.alchemy.com/)

### Installation

```bash
# Clone & install
npm install

# Configure environment
cp .env.example .env.local
```

Edit `.env.local`:

```env
NEXT_PUBLIC_ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY
```

### Development

```bash
npm run dev
```

→ Open [http://localhost:3000](http://localhost:3000)

### Production

```bash
npm run build
npm start
```

---

## 📖 Usage

1. Set your Alchemy API key in `.env.local`
2. Click **Start** to begin scanning the mempool
3. Detected opportunities stream into the right panel in real-time
4. Click **Execute** to dispatch the atomic arbitrage transaction

### Default Configuration

| Parameter | Value |
|-----------|------:|
| Min Profit Threshold | `$50 USD` |
| Max Gas Price | `50 Gwei` |
| Trade Amount | `1 ETH` *(flash loan)* |
| Scan Interval | `5s` |

---

## 📁 Project Structure

```
.
├── app/                          # Next.js App Router
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   └── monitors/
│       ├── ArbitrageControl.tsx  # Control panel
│       └── OpportunityList.tsx   # Opportunity feed
├── lib/
│   ├── config.ts                 # DEX addresses & params
│   ├── hooks/
│   │   └── useArbitrage.ts       # Arbitrage state machine
│   └── utils/                    # Helpers
└── types/
    └── monitor.ts                # Type definitions
```

---

## ✅ Verification

See [`VERIFICATION_GUIDE.md`](./VERIFICATION_GUIDE.md) for how to verify whether a detected opportunity would have settled profitably on-chain.

---

## ⚠️ Disclaimer

> This project is built for **educational purposes only**.

- 🧪 Thorough testing is required before using real funds
- ⛽ Gas fees apply on every smart contract execution
- 📉 Arbitrage trades can fail and result in net losses
- 🔐 **Never commit private keys to source control**

---

## 📄 License

Released under the [MIT License](./LICENSE).

<div align="center">

**Built with ⚡ for the DeFi community**

</div>
