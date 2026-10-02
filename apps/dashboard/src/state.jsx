import React, { createContext, useContext, useEffect, useRef, useState } from 'react'

const Ctx = createContext(null)
export const useApp = () => useContext(Ctx)

// USD/ETH/USDT conversion factors driven by live prices (CoinGecko via proxy).
export function convert(usd, currency, prices) {
  const eth = prices?.ethereum?.usd || 0
  const usdt = prices?.tether?.usd || 1
  if (currency === 'ETH' && eth) return { v: usd / eth, unit: 'ETH' }
  if (currency === 'USDT' && usdt) return { v: usd / usdt, unit: 'USDT' }
  return { v: usd, unit: 'USD' }
}
export function fmt(usd, currency, prices, digits = 4) {
  const { v, unit } = convert(usd ?? 0, currency, prices)
  const d = unit === 'USD' || unit === 'USDT' ? 2 : digits
  const sign = unit === 'USD' ? '$' : unit === 'USDT' ? '₮' : 'Ξ'
  return `${sign}${v.toLocaleString(undefined, { maximumFractionDigits: d })}`
}

export function AppProvider({ children }) {
  const [refreshMs, setRefreshMs] = useState(5000)
  const [currency, setCurrency] = useState('USD')
  const [profitPeriod, setProfitPeriod] = useState('life') // 'day' | 'life'
  const [prices, setPrices] = useState(null)
  const [all, setAll] = useState({ live: false, chains: {} })
  const [history, setHistory] = useState([]) // [{t, net}]
  const timer = useRef(null)

  const tick = async () => {
    try {
      const [m, p] = await Promise.all([
        fetch('/api/metrics/all').then(r => r.json()),
        fetch('/api/prices').then(r => r.json()).catch(() => null),
      ])
      setAll(m)
      if (p && !p.error) setPrices(p)
      const net = Object.values(m.chains || {}).reduce(
        (s, c) => s + (c ? (c['arb_gross_profit_usd_total'] || 0) : 0), 0)
      setHistory(h => [...h.slice(-120), { t: Date.now(), net }])
    } catch { /* keep last frame */ }
  }

  useEffect(() => {
    tick()
    clearInterval(timer.current)
    timer.current = setInterval(tick, refreshMs)
    return () => clearInterval(timer.current)
  }, [refreshMs])

  return (
    <Ctx.Provider value={{ refreshMs, setRefreshMs, currency, setCurrency, profitPeriod, setProfitPeriod, prices, all, history }}>
      {children}
    </Ctx.Provider>
  )
}
