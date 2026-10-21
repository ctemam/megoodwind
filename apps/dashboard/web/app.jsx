const { useEffect, useState, useRef } = React;

const fmt$ = (n) => `$${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const tc = (s) => String(s ?? '').replace(/_/g, ' ').toLowerCase().replace(/\w/g, (c) => c.toUpperCase());
const trunc = (a, max = 16) => (a && a.length > max ? `${a.slice(0, Math.floor(max / 2))}…${a.slice(-Math.floor(max / 2))}` : a ?? '—');
const copy = (t) => navigator.clipboard?.writeText(t);

const PAGES = ['Profit Metrics', 'Strategy', 'Chains', 'Wallet', 'Infra', 'Deployment', 'Configuration', 'Engine', 'Report'];
const PAGE_ICON = { 'Profit Metrics': '◎', Strategy: '⟁', Chains: '⛓', Wallet: '▣', Infra: '◈', Deployment: '▤', Configuration: '⚙', Engine: '▶', Report: '▦' };

const Dot = ({ s }) => <span className={`dot ${s === 'LIVE' || s === 'live' || s === true ? 'live' : /^SUSPENDED|dead|false/.test(String(s)) ? 'dead' : 'armed'}`} />;

const REGIME_HINT = {
  HIGH_VOL_TRENDING: 'Mean Reversion Suppressed · Momentum+Cpv Prioritized',
  LOW_VOL_MEAN_REVERTING: 'Momentum+Cpv Suppressed · Mean Rev+Stat Arb Prioritized',
  ILLIQUID_CRASH: 'Stat Arb Only · Min Depth ≥$250k Floor',
  BALANCED: 'All 12 Variants Eligible',
};

/* ── Foldable table: ▶/▼ arrow is the ONLY collapse trigger.
 *   Collapsing renders sum roll-ups of numeric columns on the header row. */
function Fold({ title, cols, rows, rollups, defaultOpen = false, right, foot }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="hairline mb-px">
      <header className="metallic-head flex h-8 items-center gap-2 px-2 text-[10px] tracking-widest dim">
        <button onClick={() => setOpen(!open)} className="w-4 text-left text-white hover:text-[#00FF66]" title={open ? 'Collapse' : 'Expand'}>
          {open ? '▼' : '▶'}
        </button>
        <span>{title}</span>
        {!open && rollups && <span className="ml-auto flex gap-4 normal-case tracking-normal">{rollups.map(([k, v]) => <span key={k}><span className="dim">{k}</span> <span className="text-white">{v}</span></span>)}</span>}
        {open && right && <span className="ml-auto">{right}</span>}
      </header>
      {open && (
        <div className="max-h-[60vh] overflow-x-auto overflow-y-auto">
        <table className="w-max max-w-none text-left text-[11px]">
          <thead>
            <tr className="hairline-b dim text-[9px] tracking-widest">
              {cols.map((c) => <th key={c} className="px-2 py-1 font-normal whitespace-nowrap">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((r, i) => (
              <tr key={i} className="hairline-b">
                {r.map((c, j) => <td key={j} className="px-2 py-1.5 whitespace-nowrap">{c}</td>)}
              </tr>
            )) : <tr><td className="px-2 py-2 dim text-[10px]" colSpan={cols.length}>No Records — Awaiting Live Data</td></tr>}
          </tbody>
          {foot && (
            <tfoot>
              <tr className="border-t border-[#2E2E2E] bg-[#141414]">
                {foot.map((c, j) => <td key={j} className="px-2 py-1.5 whitespace-nowrap">{c}</td>)}
              </tr>
            </tfoot>
          )}
        </table>
        </div>
      )}
    </section>
  );
}

const Tip = ({ text, children }) => <span className="tt" data-tt={text}>{children}</span>;

/* ── chain + valuation helpers ─────────────────────────────────── */
const CHAIN_NAME = {
  '0x1': 'eth', '0x38': 'bsc', '0x89': 'poly', '0xa4b1': 'arb', '0xa': 'op',
  '0xa86a': 'avax', '0x2105': 'base', '0xe708': 'linea', '0x82750': 'scroll', '0x13e31': 'blast',
};
/* native-token price feed handles (DexScreener token endpoints, wrapped natives) */
const NATIVE_PRICE_TOKEN = {
  '0x38': '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
  '0x89': '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WPOL
  '0xa86a': '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
};
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const fmtEth = (n) => `${Number(n ?? 0).toFixed(5)} Ξ`;

const useTicker = (ms) => {
  const [t, setT] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setT(Date.now()), ms); return () => clearInterval(i); }, [ms]);
  return t;
};

const loadStored = (k, dflt) => { try { return JSON.parse(localStorage.getItem(k)) ?? dflt; } catch { return dflt; } };
const saveStored = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } };

const TIME_WINDOWS = [
  ['1 Min', 60e3], ['15 Min', 900e3], ['30 Min', 1800e3], ['1 Hour', 3600e3],
  ['3 Hours', 10800e3], ['6 Hours', 21600e3], ['12 Hours', 43200e3],
  ['1 Day', 86400e3], ['7 Days', 604800e3], ['Months', Infinity],
];

/* ── Digital Watch — HH:MM:SS + gear settings modal ─────────────── */
const ALL_TZ = (() => {
  try { return Intl.supportedValuesOf('timeZone'); }
  catch { return ['UTC', 'Africa/Addis_Ababa', 'Europe/London', 'America/New_York', 'Asia/Tokyo']; }
})();

function DigitalWatch() {
  const [cfg, setCfg] = useState(() => {
    const c = loadStored('ab_watch', { hour12: false, seconds: true, tz: null });
    if (c.offsetMin != null) delete c.offsetMin; // migrate legacy offset → IANA zones
    return c;
  });
  const [open, setOpen] = useState(false);
  const [tzFilter, setTzFilter] = useState('');
  const t = useTicker(1000);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit',
    ...(cfg.seconds ? { second: '2-digit' } : {}),
    hour12: cfg.hour12,
    ...(cfg.tz ? { timeZone: cfg.tz } : {}),
  });
  const zoneName = cfg.tz ?? (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Local');
  const zones = tzFilter ? ALL_TZ.filter((z) => z.toLowerCase().includes(tzFilter.toLowerCase())) : ALL_TZ;
  const set = (patch) => { const n = { ...cfg, ...patch }; setCfg(n); saveStored('ab_watch', n); };
  return (
    <span className="relative inline-flex items-center gap-1">
      <span className="num text-[12px]" title={zoneName}>
        {fmt.format(t)} <span className="dim ml-1 text-[9px]">{zoneName}</span>
      </span>
      <button onClick={() => setOpen(!open)} className="dim hover:text-white" title="Watch Settings">⚙</button>
      {open && (
        <div className="hairline absolute right-0 top-6 z-50 w-64 bg-[#0A0A0B] p-3 text-[10px]">
          <div className="mb-2 tracking-widest dim">Watch Settings</div>
          <label className="mb-1 flex items-center gap-2"><input type="checkbox" checked={cfg.hour12} onChange={(e) => set({ hour12: e.target.checked })} /> 12h Format</label>
          <label className="mb-1 flex items-center gap-2"><input type="checkbox" checked={cfg.seconds} onChange={(e) => set({ seconds: e.target.checked })} /> Show Seconds</label>
          <div className="mb-1 mt-2 dim tracking-widest">Time Zone</div>
          <input value={tzFilter} onChange={(e) => setTzFilter(e.target.value)} aria-label="Filter Time Zones"
            className="hairline mb-1 w-full bg-transparent px-2 py-1 text-white" />
          <select value={cfg.tz ?? '__local__'} onChange={(e) => set({ tz: e.target.value === '__local__' ? null : e.target.value })}
            size="8" className="hairline w-full bg-black text-white" aria-label="Time Zone">
            <option value="__local__" className="bg-black">— Local System —</option>
            {zones.map((z) => <option key={z} value={z} className="bg-black">{z.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
      )}
    </span>
  );
}

/* ── pages ─────────────────────────────────────────────────────── */
function ProfitMetrics({ m, windowMs = Infinity }) {
  const allRecs = m.settled_records ?? [];
  const recs = Number.isFinite(windowMs) ? allRecs.filter((r) => r.ts >= Date.now() - windowMs) : allRecs;
  const net = recs.reduce((s, r) => s + (r.netUsd ?? 0), 0);
  const pj = m.projections;
  const an = m.analytics;
  const kpis = [
    ['Settled Net P/L', fmt$(net), net >= 0 ? 'acc' : 'bad'],
    ['Settled Trades', recs.length],
    ['Avg Net / Trade', recs.length ? fmt$(net / recs.length) : '—'],
    ['Best Trade', fmt$(Math.max(0, ...recs.map((r) => r.netUsd)))],
    ['Peak Sim Yield', an ? fmt$(an.peak_profit_usd) : '—', 'acc'],
    ['Profit Ratio Predictive', an ? `${an.profit_ratio_predictive.toFixed(1)}%` : '—', 'num'],
    ['Profit Ratio Whale', an ? `${an.profit_ratio_whale.toFixed(1)}%` : '—', 'num'],
    ['Projected /Hr (Simulation)', pj ? fmt$(pj.simPerHourUsd) : '—', pj ? 'acc' : 'dim'],
    ['Projected /Hr (Production)', pj ? fmt$(pj.prodPerHourUsd) : '—', pj ? 'acc' : 'dim'],
    ['Fork Window', pj ? `${Math.round(pj.windowSec / 60)}min · ${pj.cycles} Cycles · ${pj.profitableCandidates} Winners` : '—', 'dim'],
  ];
  return (<>
    <div className="flex flex-col w-full">
      {kpis.map(([k, v, t]) => <div key={k} className="bg-[#000000] p-3 border-b border-[#1A1A1A] w-full"><div className="text-[9px] tracking-widest dim">{k}</div><div className={`mt-1 text-lg ${t ?? 'num'}`}>{v}</div></div>)}
    </div>
    <Fold title="Settled Records" cols={['Time', 'Chain', 'Strategy', 'Spread %', 'Net', 'Tx Hash']} defaultOpen
      rollups={[['Total', fmt$(net)], ['Trades', recs.length], ['Avg', m.settled_count ? fmt$(net / m.settled_count) : '—']]}
      rows={recs.slice(-20).reverse().map((r) => [ 
        new Date(r.ts).toLocaleTimeString(), r.chain, r.strategy, r.spreadPct.toFixed(2),
        <span className={r.netUsd >= 0 ? 'acc' : 'bad'}>{fmt$(r.netUsd)}</span>,
        <Tip text={r.txHash}><span className="dim cursor-pointer" onClick={() => copy(r.txHash)}>{trunc(r.txHash)} ⧉</span></Tip>,
      ])} />
  </>);
}

/* ── forensic filtration audit — four hard gate counters ── */
const GATES = [
  ['total_detected_opportunities', 'Total Detected Opportunities'],
  ['rejected_by_forensic_bait', 'Rejected By Forensic Bait'],
  ['rejected_by_profit_margin', 'Rejected By Profit Margin'],
  ['passed_to_simulation_probe', 'Passed To Simulation Probe'],
];
function GateAudit({ m }) {
  const g = m.forensicGates ?? {};
  return (
    <div className="metallic border hairline flex flex-col w-full">
      <div className="metallic-head px-3 py-2 text-[10px] tracking-widest dim">Forensic Filtration Audit</div>
      <div className="flex flex-col w-full">
        {GATES.map(([k, label]) => (
          <div key={k} className="flex items-center justify-between px-3 py-2 border-b border-[#1A1A1A] last:border-b-0 w-full">
            <span className="text-[11px] dim">{label}</span>
            <span className="font-mono text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.3)] text-[13px]">{g[k] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Strategy({ m, ops }) {
  const variants = Object.entries(m.variants ?? {});
  const pj = m.projections;
  const stratSplit = pj?.strategyHits ? Object.entries(pj.strategyHits) : [];
  const varSplit = pj?.variantHits ? Object.entries(pj.variantHits) : [];
  return (<>
    <GateAudit m={m} />
    {(m.analytics?.variant_performance_ledger?.length ?? 0) ? (
      <Fold title="Variant Performance Ledger" cols={['Variant', 'Lane', 'Hits', 'Misses', 'Floor', 'Max Profit', 'Net']} defaultOpen
        rollups={[['Variants', m.analytics.variant_performance_ledger.length], ['Hits', m.analytics.variant_performance_ledger.reduce((s, r) => s + r.hits, 0)], ['Net', fmt$(m.analytics.variant_performance_ledger.reduce((s, r) => s + r.netUsd, 0))]]}
        rows={m.analytics.variant_performance_ledger.map((r) => [
          <span className="acc">{r.variant}</span>,
          <span className="dim">{tc(r.lane)}</span>,
          r.hits,
          <span className={r.misses ? 'bad' : 'dim'}>{r.misses}</span>,
          <span className="num">{fmt$(r.minProfitFloorUsd)}</span>,
          <span className="font-mono text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.3)]">{fmt$(r.maxProfitUsd)}</span>,
          <span className={r.netUsd >= 0 ? 'acc' : 'bad'}>{fmt$(r.netUsd)}</span>,
        ])} />
    ) : null}
    {pj ? (
      <Fold title="Simulation Profit Split" cols={['Lane', 'Hits', 'Net']} defaultOpen
        rollups={[['Predictive', pj.lanes?.predictive ?? 0], ['Whale', pj.lanes?.whale ?? 0], ['Accrued', fmt$(pj.accruedNetUsd ?? 0)]]}
        rows={[
          ...stratSplit.map(([s, n]) => [
            <span className="acc">{s}</span>, n,
            <span className="font-mono text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.3)]">{fmt$(pj.strategyNetUsd?.[s] ?? 0)}</span>]),
          ...varSplit.map(([v, n]) => [
            <span className="dim">{v}</span>, n,
            <span className="font-mono text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.3)]">{fmt$(pj.variantNetUsd?.[v] ?? 0)}</span>]),
        ]} />
    ) : null}
    <div className="flex flex-col gap-1 p-3 text-[11px] border-b border-[#1A1A1A] w-full">
      {Object.entries(ops.regimes ?? {}).map(([c, r]) => (
        <Tip key={c} text={`${c}: ${REGIME_HINT[r.regime] ?? ''}\nVol ${r.volBps?.toFixed(1)}bps · Trend ${r.trendScore?.toFixed(2)} · Illiq ${(r.illiquidFrac * 100).toFixed(0)}%`}>
          <span className={r.regime === 'BALANCED' ? 'dim' : r.regime === 'ILLIQUID_CRASH' ? 'bad' : 'acc'}>{c} · {tc(r.regime)}</span>
        </Tip>
      ))}
      {!Object.keys(ops.regimes ?? {}).length && <span className="dim text-[10px]">No Regime Records — Runner Idle</span>}
    </div>
    <Fold title="Variant Matrix — 12 Loops" cols={['Variant', 'Emitted', 'Settled', 'Reverts', 'Net', 'Ewma']} defaultOpen
      rollups={[['Variants', variants.length], ['Emitted', variants.reduce((s, [, v]) => s + (v.emitted ?? 0), 0)], ['Net', fmt$(variants.reduce((s, [, v]) => s + (v.netUsd ?? 0), 0))]]}
      rows={variants.map(([id, s]) => [
        id, s.emitted, s.settled,
        <span className={s.reverts ? 'bad' : 'dim'}>{s.reverts}</span>,
        <span className={s.netUsd >= 0 ? 'acc' : 'bad'}>{fmt$(s.netUsd)}</span>,
        `${Math.round(s.ewmaLatencyMs ?? 0)}ms`,
      ])} />
  </>);
}

function Chains({ m, ops }) {
  const lanes = ops.lanes ?? [];
  const oracle = ops.l1oracle ?? {};
  const chainRows = Object.keys({ ...(m.pools ?? {}), ...(ops.regimes ?? {}), ...oracle }).map((c) => {
    const cl = lanes.filter((l) => l.chain === c);
    const o = oracle[c];
    return [c, m.pools?.[c] ?? 0, m.convicted?.[c] ?? 0, cl.length,
      cl.length ? <span className="num">{Math.round(cl.reduce((s, l) => s + l.p50Ms, 0) / cl.length)}ms</span> : '—',
      ops.regimes?.[c]?.regime ? tc(ops.regimes[c].regime) : '—',
      o ? <span className="font-mono text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.3)]">{(Number(o.l1DataFeeWei) / 1e18).toExponential(2)}Ξ</span> : <span className="dim">—</span>];
  });
  return (<>
  <Fold title="Chain Status Boards" cols={['Chain', 'Pools', 'Convicted', 'Lanes', 'P50', 'Regime', 'L1 Data Fee']} defaultOpen
    rollups={[['Chains', chainRows.length], ['Pools', chainRows.reduce((s, r) => s + r[1], 0)], ['Lanes', chainRows.reduce((s, r) => s + r[3], 0)]]}
    rows={chainRows} />
  {Object.keys(oracle).length ? (
    <Fold title="L1 Data Fee Scalars" cols={['Chain', 'L1 Base Fee', 'Blob Base Fee', 'Base Scalar', 'Blob Scalar']} defaultOpen
      rollups={[['Oracles', Object.keys(oracle).length]]}
      rows={Object.entries(oracle).map(([c, o]) => [
        c,
        <span className="font-mono text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.3)]">{(Number(o.l1BaseFeeWei) / 1e9).toFixed(3)} gwei</span>,
        <span className="font-mono text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.3)]">{(Number(o.blobBaseFeeWei) / 1e9).toFixed(4)} gwei</span>,
        <span className="num">{o.baseFeeScalar}</span>,
        <span className="num">{o.blobBaseFeeScalar}</span>,
      ])} />
  ) : null}
  </>);
}
async function probeAccount(addr) {
  const eth = window.ethereum;
  if (!eth) return { chain: '—', balanceWei: null, nonce: null };
  try {
    const [chainId, balHex, nonceHex] = await Promise.all([
      eth.request({ method: 'eth_chainId' }),
      eth.request({ method: 'eth_getBalance', params: [addr, 'latest'] }),
      eth.request({ method: 'eth_getTransactionCount', params: [addr, 'latest'] }),
    ]);
    return {
      chain: CHAIN_NAME[chainId] ?? chainId, chainId,
      balanceWei: BigInt(balHex), nonce: parseInt(nonceHex, 16),
    };
  } catch { return { chain: '—', balanceWei: null, nonce: null }; }
}

function Wallet({ ops, accounts, setAccounts, prices }) {
  const w = ops.wallet ?? {};
  const [manual, setManual] = useState('');
  const [probeErr, setProbeErr] = useState(null);
  const hasEth = typeof window !== 'undefined' && !!window.ethereum;

  const refresh = async (list) => {
    const out = await Promise.all((list ?? accounts).map(async (a) => ({ ...a, ...(await probeAccount(a.address)) })));
    setAccounts(out);
  };
  useEffect(() => {
    if (!accounts.length || !hasEth) return;
    refresh();
    const i = setInterval(() => refresh(), 15000);
    return () => clearInterval(i);
  }, [accounts.length, hasEth]);

  const detect = async () => {
    setProbeErr(null);
    try {
      const addrs = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const known = new Set(accounts.map((a) => a.address.toLowerCase()));
      const fresh = addrs.filter((a) => !known.has(a.toLowerCase()))
        .map((a) => ({ address: a, source: 'Injected', addedAt: Date.now(), chain: '…', balanceWei: null, nonce: null }));
      const next = [...accounts, ...fresh];
      setAccounts(next);
      await refresh(next);
    } catch (e) { setProbeErr(e?.message ?? 'Request Rejected'); }
  };

  const addManual = () => {
    const a = manual.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { setProbeErr('Invalid 0x Address'); return; }
    if (accounts.some((x) => x.address.toLowerCase() === a.toLowerCase())) { setProbeErr('Already Tracked'); return; }
    setProbeErr(null); setManual('');
    const next = [...accounts, { address: a, source: 'Manual', addedAt: Date.now(), chain: '…', balanceWei: null, nonce: null }];
    setAccounts(next);
    refresh(next);
  };

  const usdOf = (a) => a.balanceWei != null
    ? Number(a.balanceWei) / 1e18 * (prices?.[a.chain] ?? NaN) : NaN;
  const ethOf = (a) => a.balanceWei != null ? Number(a.balanceWei) / 1e18 : NaN;
  const totalUsd = accounts.reduce((s, a) => s + (usdOf(a) || 0), 0);
  const totalNative = accounts.reduce((s, a) => s + (ethOf(a) || 0), 0);
  const priced = accounts.some((a) => Number.isFinite(usdOf(a)));

  const idRow = (label, addr) => [
    label,
    addr ? <><span className="dim">{addr}</span> <button className="text-white hover:text-[#00FF66] ml-2" onClick={() => copy(addr)} title="Copy">⧉</button></> : <span className="dim">Not Configured</span>,
  ];

  return (<>
    <div className="hairline flex flex-col gap-2 p-3 w-full">
      <div className="flex items-center gap-2">
        <button onClick={detect} disabled={!hasEth}
          className="hairline metallic px-4 py-2 text-[11px] tracking-widest text-white hover:border-[#4f8ff7] hover:text-[#4f8ff7] disabled:opacity-30">
          {hasEth ? '⛁ Detect Wallet & Connect' : 'No EIP-1193 Provider Detected'}
        </button>
        {probeErr && <span className="bad text-[10px]">{probeErr}</span>}
      </div>
      <div className="flex items-center gap-2">
        <span className="dim text-[10px] tracking-widest">Add Account Manually</span>
        <input value={manual} onChange={(e) => setManual(e.target.value)} aria-label="Add Account Manually"
          className="hairline w-96 bg-transparent px-2 py-1 text-[11px] text-white" />
        <button onClick={addManual} className="hairline px-3 py-1 text-[10px] tracking-widest dim hover:text-white">+ Add</button>
      </div>
    </div>

    <Fold title="Tracked Accounts" cols={['Time', 'Chain', 'Account Address', 'Native Gas Balance', 'Token Reserves', 'Nonce Sequence']} defaultOpen
      rollups={[['Accounts', accounts.length], ['Σ Native', fmtEth(totalNative)], [priced ? 'Σ Est Usd' : 'Σ Usd', priced ? fmt$(totalUsd) : '—']]}
      foot={[
        <span className="dim tracking-widest text-[9px]">Total</span>,
        `${accounts.length} Acct`,
        <span className="dim">All Networks</span>,
        <span className="acc text-[12px]">{fmtEth(totalNative)}{priced ? ` · ${fmt$(totalUsd)}` : ''}</span>,
        <span className="dim">—</span>,
        <span className="num">{accounts.reduce((s, a) => s + (a.nonce ?? 0), 0)}</span>,
      ]}
      rows={accounts.map((a) => [
        new Date(a.addedAt).toLocaleTimeString(),
        a.chain,
        <Tip text={a.address}><span className="dim cursor-pointer" onClick={() => copy(a.address)}>{trunc(a.address, 18)} ⧉</span></Tip>,
        a.balanceWei != null
          ? <span className="num">{fmtEth(ethOf(a))}{Number.isFinite(usdOf(a)) ? <span className="dim"> ≈{fmt$(usdOf(a))}</span> : null}</span>
          : <span className="dim">—</span>,
        <Tip text="Token enumeration requires indexer feed — native balance live via EIP-1193"><span className="dim">—</span></Tip>,
        a.nonce != null ? <span className="num">{a.nonce}</span> : <span className="dim">—</span>,
      ])} />

    <Fold title="Account Identities" cols={['Identity', 'Address']} defaultOpen
      rows={[idRow('Smart Account', w.smartAccount), idRow('Profit Wallet', w.profitWallet)]} />
    <Fold title="Impersonation Ledger — Fork Dry-Runs" cols={['Time', 'Chain', 'Strategy', 'Legs', 'Sim Status', 'Gas']}
      rollups={[['Dry-Runs', (ops.simLedger ?? []).length], ['Pass', (ops.simLedger ?? []).filter((r) => r.sim?.status === 'PASS').length]]}
      rows={(ops.simLedger ?? []).map((r) => [
        new Date(r.ts).toLocaleTimeString(), r.chain, r.candidate?.strategy, (r.candidate?.legs ?? []).length,
        <span className={r.sim?.status === 'PASS' ? 'acc' : r.sim?.status ? 'bad' : 'dim'}>{r.sim?.status ?? r.sim?.sim_gate ?? '—'}</span>,
        r.sim?.gasUsed ? <span className="num">{Number(r.sim.gasUsed).toLocaleString()}</span> : '—',
      ])} />
  </>);
}

function Infra({ ops }) {
  const providers = ops.providers ?? {};
  const lanes = ops.lanes ?? [];
  return (<>
    <Fold title="Provider Lanes" cols={['Status', 'Provider', 'P50', 'Chains']} defaultOpen
      rollups={[['Providers', Object.keys(providers).length], ['Live', Object.values(providers).filter((p) => !/^SUSPENDED/.test(p.status ?? '')).length], ['Lanes', lanes.length]]}
      rows={Object.entries(providers).map(([id, p]) => {
        const pl = lanes.filter((l) => l.provider === id);
        const p50 = pl.length ? `${Math.round(pl.reduce((s, l) => s + l.p50Ms, 0) / pl.length)}ms` : '—';
        const tt = [`Status: ${p.status}`, `Safe Rps: ${p.safe_rps}`, `Daily Budget: ${(p.daily_budget ?? 0).toLocaleString()}`, `Chains: ${(p.supported_chains ?? []).join(',')}`,
          pl.length ? `P95: ${Math.round(pl.reduce((s, l) => s + l.p95Ms, 0) / pl.length)}ms` : 'No Benchmark Yet'].join('\n');
        return [<Dot s={p.status} />, <Tip text={tt}>{id}</Tip>, <span className="num">{p50}</span>, (p.supported_chains ?? []).join(', ')];
      })} />
    <Fold title="Daemon Loops" cols={['Daemon', 'Last Line', 'Cycles']} defaultOpen
      rows={[['Sync Rpc Status (60s)', <span className="dim">{trunc(ops.daemon?.lastLine, 60)}</span>, ops.daemon?.lines ?? '—']]} />
  </>);
}

function Deployment({ ops }) {
  const d = ops.deployment ?? {};
  const rows = [
    ['Multicall3', 'All Chains', <Tip text={d.multicall3}><span className="dim cursor-pointer" onClick={() => copy(d.multicall3)}>{trunc(d.multicall3)} ⧉</span></Tip>],
    ...Object.entries(d.executors ?? {}).map(([c, a]) => [
      'AllBrightExecutor', c,
      <Tip text={a}><span className="dim cursor-pointer" onClick={() => copy(a)}>{trunc(a)} ⧉</span></Tip>,
    ]),
  ];
  return <Fold title="Contract Deployments" cols={['Contract', 'Chain', 'Address']} defaultOpen
    rollups={[['Contracts', rows.length]]} rows={rows} />;
}

function Configuration({ m, ops }) {
  const rows = Object.entries(ops.configuration ?? {}).map(([k, v]) => [
    <span className="dim">{k}</span>, String(v),
  ]);
  const pj = m.projections;
  const liveRows = pj ? [
    [<span className="dim">Active Variant</span>, <span className="val">{pj.activeVariant ?? '—'}</span>],
    [<span className="dim">Market Regime</span>, <span className="val">{pj.regime ?? '—'}</span>],
    [<span className="dim">Fork Block</span>, <span className="val">{pj.forkBlock ?? '—'}</span>],
    [<span className="dim">Pools Evaluated</span>, <span className="val">{pj.pools ?? '—'}</span>],
    [<span className="dim">Cycles</span>, <span className="val">{pj.cycles ?? '—'}</span>],
    [<span className="dim">Lanes Predictive / Whale</span>, <span className="val">{pj.lanes ? `${pj.lanes.predictive} / ${pj.lanes.whale}` : '—'}</span>],
    [<span className="dim">Gates Detected / Passed</span>, <span className="val">{pj.forensicGates ? `${pj.forensicGates.total_detected_opportunities} / ${pj.forensicGates.passed_to_simulation_probe}` : '—'}</span>],
    [<span className="dim">Sim Per Hour</span>, <span className="val">${(pj.simPerHourUsd ?? 0).toFixed(2)}</span>],
    [<span className="dim">Prod Per Hour</span>, <span className="val">${(pj.prodPerHourUsd ?? 0).toFixed(2)}</span>],
  ] : [];
  return (<>
    {liveRows.length ? (
      <Fold title="Live Simulation State" cols={['Metric', 'Value']} defaultOpen
        rollups={[['Window', `${pj.windowSec}s`], ['Profitable', pj.profitableCandidates ?? 0]]}
        rows={liveRows} />
    ) : null}
    <Fold title="Runtime Parameters" cols={['Key', 'Value']} defaultOpen
      rollups={[['Params', rows.length], ['Mode', m.config?.autoExecute ? 'Live' : 'Shadow']]}
      rows={rows} />
    <div className="p-2 text-[10px] dim">API Keys & Secrets Deliberately Excluded From This Surface.</div>
  </>);
}

function Engine({ m, ops, refresh }) {
  const [busy, setBusy] = useState(false);
  const act = async (action) => {
    setBusy(true);
    await fetch('/api/engine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }).catch(() => undefined);
    setBusy(false);
    refresh?.();
  };
  const running = ops.engine?.running;
  return (
    <div className="p-4">
      <div className="mb-4 flex flex-col gap-1 text-[11px]">
        <span><Dot s={running} /> {running ? `Runner Active — PID ${ops.engine?.pid}` : 'Runner Stopped'}</span>
        <span className="warn">Auto-Execute Forced False — Shadow Only From UI</span>
      </div>
      <div className="flex flex-col gap-2 w-full">
        <button disabled={busy || running} onClick={() => act('start')}
          className="hairline px-4 py-2 text-[11px] tracking-widest text-white hover:border-[#00FF66] hover:text-[#00FF66] disabled:opacity-30">▶ START</button>
        <button disabled={busy || !running} onClick={() => act('stop')}
          className="hairline px-4 py-2 text-[11px] tracking-widest text-white hover:border-[#FF4444] hover:text-[#FF4444] disabled:opacity-30">■ PAUSE</button>
      </div>
      <div className="mt-4 text-[10px] dim">Spawns npx tsx src/runner/arbRunner.ts Under The Dashboard Process. Kill Switch Also Removes The Child.</div>
    </div>
  );
}

function Report({ m, ops }) {
  const signals = ops.signals ?? {};
  const lanes = ops.lanes ?? [];
  return (<>
    <GateAudit m={m} />
    <Fold title="Signal Streams" cols={['Chain', 'Records', 'Whales']} defaultOpen
      rollups={[['Chains', Object.keys(signals).length], ['Records', Object.values(signals).reduce((s, x) => s + x.records, 0)], ['Whales', Object.values(signals).reduce((s, x) => s + x.whales, 0)]]}
      rows={Object.entries(signals).map(([c, s]) => [c, s.records, s.whales])} />
    <Fold title="Gate Counters" cols={['Counter', 'Labels', 'Count']} defaultOpen
      rollups={[['Counters', Object.keys(m.counters ?? {}).length], ['Total', Object.values(m.counters ?? {}).reduce((a, b) => a + b, 0)]]}
      rows={Object.entries(m.counters ?? {}).map(([k, v]) => { const [n, l] = k.split('|'); return [n, <span className="dim">{l}</span>, v]; })} />
    <Fold title="Benchmark History" cols={['Chain', 'Provider', 'P50', 'P95', 'Ok']} 
      rollups={[['Lanes', lanes.length], ['Best P50', lanes.length ? `${Math.min(...lanes.map((l) => l.p50Ms))}ms` : '—']]}
      rows={lanes.map((l) => [l.chain, l.provider, <span className="num">{l.p50Ms}ms</span>, <span className="num">{l.p95Ms}ms</span>, `${l.ok}/${l.ok + l.fail}`])} />
  </>);
}

/* ── shell ─────────────────────────────────────────────────────── */
function App() {
  const [page, setPage] = useState(() => {
    const h = decodeURIComponent(location.hash.slice(1));
    return PAGES.includes(h) ? h : 'Profit Metrics';
  });
  const [m, setM] = useState(null);
  const [ops, setOps] = useState({});
  const [wsUp, setWsUp] = useState(false);
  const [err, setErr] = useState(null);
  const [unit, setUnit] = useState(() => loadStored('ab_unit', 'usd'));
  const [profitSpan, setProfitSpan] = useState('lifetime');
  const [windowMs, setWindowMs] = useState(Infinity);
  const [refreshSec, setRefreshSec] = useState(() => loadStored('ab_refresh', 3));
  const [accounts, setAccounts] = useState(() => loadStored('ab_accounts', []));
  const [prices, setPrices] = useState({});
  const wsRef = useRef(null);

  // persist tracked accounts (strip live probe fields)
  useEffect(() => {
    saveStored('ab_accounts', accounts.map(({ address, source, addedAt }) => ({ address, source, addedAt, chain: '…', balanceWei: null, nonce: null })));
  }, [accounts]);

  // native-token prices via DexScreener (same feed family the engine uses)
  useEffect(() => {
    const fetchPrices = async () => {
      const map = {};
      const pull = async (token, keys) => {
        try {
          const j = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`)).json();
          const p = Number(j.pairs?.[0]?.priceUsd ?? NaN);
          if (Number.isFinite(p)) keys.forEach((k) => { map[k] = p; });
        } catch { }
      };
      await pull(WETH, ['eth', 'arb', 'op', 'base', 'linea', 'scroll', 'blast']);
      await pull(NATIVE_PRICE_TOKEN['0x38'], ['bsc']);
      await pull(NATIVE_PRICE_TOKEN['0x89'], ['poly']);
      await pull(NATIVE_PRICE_TOKEN['0xa86a'], ['avax']);
      setPrices(map);
    };
    fetchPrices();
    const i = setInterval(fetchPrices, 60000);
    return () => clearInterval(i);
  }, []);

  const pull = async () => {
    // independent fetches — /api/ops is served locally (authoritative for the
    // shell); /api/metrics proxies :3001 and may be down — never fatal.
    try { setOps(await (await fetch('/api/ops')).json()); setErr(null); }
    catch (e) { setErr(String(e)); }
    try { setM(await (await fetch('/api/metrics')).json()); }
    catch { /* metrics api offline — ops shell still renders */ }
  };

  useEffect(() => {
    pull();
    // live WebSocket — falls back to 3s REST polling when the socket is down
    const ws = new WebSocket(`ws://${location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => setWsUp(true);
    ws.onclose = () => setWsUp(false);
    ws.onmessage = (e) => {
      const s = JSON.parse(e.data);
      if (s.metrics) setM(s.metrics);
      if (s.ops) setOps(s.ops);
      setErr(null);
    };
    return () => { ws.close(); };
  }, []);

  // REST fallback cadence — operator-selectable 1s–30s (only polls while ws is down)
  useEffect(() => {
    const t = setInterval(() => { if (!wsRef.current || wsRef.current.readyState !== 1) pull(); }, refreshSec * 1000);
    return () => clearInterval(t);
  }, [refreshSec]);

  if (err) return <div className="p-8 bad">Dashboard Api Unreachable: {err}</div>;
  const metrics = m ?? {};

  // valuation conversion — usd is native; eth = usd / ethUsd
  const ethUsd = prices.eth;
  const val = (usd) => {
    if (unit === 'eth') {
      return Number.isFinite(ethUsd) ? `${(usd / ethUsd).toFixed(5)} Ξ` : '—';
    }
    return fmt$(usd);
  };

  // profit pulse — aggregate of all injected/tracked accounts
  const pulseUsd = accounts.reduce((s, a) => {
    const p = prices[a.chain];
    return s + (a.balanceWei != null && Number.isFinite(p) ? Number(a.balanceWei) / 1e18 * p : 0);
  }, 0);
  const recs = metrics.settled_records ?? [];
  const dayNet = recs.filter((r) => r.ts >= Date.now() - 86400e3).reduce((s, r) => s + (r.netUsd ?? 0), 0);
  const profitShown = profitSpan === 'day' ? dayNet : (metrics.arb_settled_net_usd ?? 0);

  const killSwitch = async () => {
    if (!window.confirm('Emergency Kill — Stop Runner?')) return;
    await fetch('/api/engine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }).catch(() => undefined);
    pull();
  };

  const lanes = ops.lanes ?? [];
  const pageBody = {
    'Profit Metrics': <ProfitMetrics m={metrics} windowMs={windowMs} />,
    Strategy: <Strategy m={metrics} ops={ops} />,
    Chains: <Chains m={metrics} ops={ops} />,
    Wallet: <Wallet ops={ops} accounts={accounts} setAccounts={setAccounts} prices={prices} />,
    Infra: <Infra ops={ops} />,
    Deployment: <Deployment ops={ops} />,
    Configuration: <Configuration m={metrics} ops={ops} />,
    Engine: <Engine m={metrics} ops={ops} refresh={pull} />,
    Report: <Report m={metrics} ops={ops} />,
  }[page];

  return (
    <div className="min-h-screen">
      <nav className="metallic fixed left-0 top-0 z-40 flex h-screen w-36 flex-col">
        <div className="flex h-14 items-center justify-center border-b border-[#1A1A1A] px-3">
          <img src="./logo.svg" className="h-8 w-auto" alt="AllBright" />
        </div>
        {PAGES.map((p) => (
          <button key={p} onClick={() => { setPage(p); location.hash = p; }}
            className={`flex h-9 items-center gap-2 border-b border-[#1A1A1A] px-3 text-left text-[10px] tracking-wide ${page === p ? 'acc bg-[#141414]' : 'dim hover:text-white'}`}>
            <span>{PAGE_ICON[p]}</span><span>{p}</span>
          </button>
        ))}
        <div className="mt-auto p-3 text-[9px] dim">
          <Dot s={wsUp} /> <span>{wsUp ? 'Ws Live' : 'Polling'}</span>
        </div>
      </nav>

      <main className="ml-36 pb-28 pt-52">
        {/* fixed top control panel — persistent telemetry + timekeepers (4× height) */}
        <header className="metallic fixed left-36 right-0 top-0 z-40 flex h-48 flex-col overflow-x-auto overflow-y-hidden border-b border-[#2E2E2E] px-6 py-3 whitespace-nowrap">
          {/* row 1 — brand + valuation + watch */}
          <div className="flex items-center gap-6 border-b border-[#1A1A1A] pb-3">
            <span className="flex items-center gap-3">
              <img src="./logo.svg" className="h-9 w-auto" alt="AllBright" />
              <span className="flex flex-col">
                <span className="text-[14px] tracking-widest text-white">AllBright</span>
                <span className="dim text-[9px] tracking-[0.3em]">Banbot Cockpit V1.0</span>
              </span>
            </span>
            <span className="hairline flex text-[10px] tracking-widest">
              {['usd', 'eth'].map((u) => (
                <button key={u} onClick={() => { setUnit(u); saveStored('ab_unit', u); }}
                  className={`px-3 py-1 ${unit === u ? 'bg-[#1e4fd8] text-white' : 'dim hover:text-white'}`}>{u === 'usd' ? 'Usd' : 'Eth'}</button>
              ))}
            </span>
            <span className="ml-auto"><DigitalWatch /></span>
          </div>
          {/* row 2 — profit + pulse + time filter */}
          <div className="flex items-center gap-8 border-b border-[#1A1A1A] py-3">
            <span className="flex items-center gap-2 text-[11px]">
              <span className="dim tracking-widest">Profit</span>
              <Tip text={profitSpan === 'day' ? 'Settled Net — Trailing 24h' : 'Settled Net — Lifetime Since Deployment'}>
                <span className={profitShown >= 0 ? 'acc text-lg' : 'bad text-lg'}>{val(profitShown)}</span>
              </Tip>
              <select value={profitSpan} onChange={(e) => setProfitSpan(e.target.value)}
                className="hairline bg-transparent px-1.5 py-1 text-[10px] dim">
                <option value="day" className="bg-black">Per Day</option>
                <option value="lifetime" className="bg-black">Lifetime</option>
              </select>
            </span>
            <span className="flex items-center gap-2 text-[11px]">
              <span className="dim tracking-widest">Profit Pulse</span>
              <Tip text={`Aggregate Of ${accounts.length} Tracked Account${accounts.length === 1 ? '' : 's'} — Live EIP-1193 Balances × Native Prices`}>
                <span className="acc text-lg">{accounts.length ? val(pulseUsd) : '—'}</span>
              </Tip>
            </span>
            <span className="flex items-center gap-2 text-[11px]">
              <span className="dim tracking-widest">Window</span>
              <select onChange={(e) => setWindowMs(Number(e.target.value))} defaultValue={Infinity}
                className="hairline bg-transparent px-2 py-1 text-[10px] dim" title="Unified Time Filter — Settled Records Window">
                {TIME_WINDOWS.map(([k, v]) => <option key={k} value={v} className="bg-black">{k}</option>)}
              </select>
            </span>
          </div>
          {/* row 3 — controls + mode */}
          <div className="flex items-center gap-6 pt-3">
            <button onClick={killSwitch}
              className="hairline px-4 py-1.5 text-[10px] tracking-widest text-[#F87171] hover:border-[#FF4444] hover:bg-[#2a0a0a]"
              title="Emergency Kill Switch — Stops The Runner Immediately">
              ▣ Emergency Kill
            </button>
            <span className="text-[12px] tracking-[0.25em] text-white">{page}</span>
            <span className="ml-auto flex items-center gap-3">
              <select value={refreshSec} onChange={(e) => { const v = Number(e.target.value); setRefreshSec(v); saveStored('ab_refresh', v); }}
                className="hairline bg-transparent px-1.5 py-1 text-[10px] dim" title="Refresh Interval" aria-label="Refresh Interval">
                {[1, 2, 3, 5, 10, 15, 20, 30].map((s) => <option key={s} value={s} className="bg-black">{s}s</option>)}
              </select>
            <span className={`text-[11px] tracking-widest ${metrics.config?.autoExecute ? 'acc' : 'warn'}`}>
              {!m ? 'Metrics Api Offline' : metrics.config?.autoExecute ? 'Live Execution' : 'Shadow Mode'}
            </span>
            </span>
          </div>
        </header>
        <div className="flex flex-col space-y-6 w-full">{pageBody}</div>
      </main>

      {/* status ribbon — 50% of the 192px control panel */}
      <footer className="metallic fixed bottom-0 left-36 right-0 z-40 flex h-24 flex-col justify-center gap-2 overflow-x-auto border-t border-[#2E2E2E] px-6 text-[11px] whitespace-nowrap">
        {(() => {
          const rps = Object.values(ops.providers ?? {}).filter((p) => !/^SUSPENDED/.test(p.status ?? '')).reduce((s, p) => s + (p.safe_rps ?? 0), 0);
          return (<>
            <div className="flex items-center gap-6">
              <span className="tt" data-tt="Fleet"><span className="dim">Fleet</span> <span className="num">~{rps.toFixed(1)} Req/S</span></span>
              <span className="tt" data-tt="Lanes"><span className="dim">Lanes</span> <span className="num">{lanes.length}</span></span>
              <span className="tt" data-tt="Engine"><span className="dim">Engine</span> <span className="num">{ops.engine?.running ? `PID ${ops.engine.pid}` : 'Off'}</span></span>
              <span className="tt" data-tt="Signals"><span className="dim">Signals</span> <span className="num">{Object.values(ops.signals ?? {}).reduce((s, x) => s + x.records, 0)}</span></span>
            </div>
            <div className="flex items-center gap-6">
              <span className="tt" data-tt="Daemon"><span className="dim">Sync</span> <span className="text-white">{trunc(ops.daemon?.lastLine, 60)}</span></span>
              <span className="ml-auto dim">AllBright © 2026</span>
            </div>
          </>);
        })()}
      </footer>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return <div className="p-8 bad">Render Fault: {String(this.state.err?.message ?? this.state.err)}</div>;
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
