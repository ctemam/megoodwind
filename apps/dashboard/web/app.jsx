const { useEffect, useState, useRef } = React;

const fmt$ = (n) => `$${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const trunc = (a, max = 16) => (a && a.length > max ? `${a.slice(0, Math.floor(max / 2))}…${a.slice(-Math.floor(max / 2))}` : a ?? '—');
const copy = (t) => navigator.clipboard?.writeText(t);

const PAGES = ['Profit Metrics', 'Strategy', 'Chains', 'Wallet', 'Infra', 'Deployment', 'Configuration', 'Engine', 'Report'];
const PAGE_ICON = { 'Profit Metrics': '◎', Strategy: '⟁', Chains: '⛓', Wallet: '▣', Infra: '◈', Deployment: '▤', Configuration: '⚙', Engine: '▶', Report: '▦' };

const Dot = ({ s }) => <span className={`dot ${s === 'LIVE' || s === 'live' || s === true ? 'live' : /^SUSPENDED|dead|false/.test(String(s)) ? 'dead' : 'armed'}`} />;

const REGIME_HINT = {
  HIGH_VOL_TRENDING: 'MEAN_REVERSION Suppressed · MOMENTUM+CPV Prioritized',
  LOW_VOL_MEAN_REVERTING: 'MOMENTUM+CPV Suppressed · MEAN_REV+STAT_ARB Prioritized',
  ILLIQUID_CRASH: 'STAT_ARB Only · minDepth ≥$250k Floor',
  BALANCED: 'All 12 Variants Eligible',
};

/* ── Foldable table: ▶/▼ arrow is the ONLY collapse trigger.
 *   Collapsing renders sum roll-ups of numeric columns on the header row. */
function Fold({ title, cols, rows, rollups, defaultOpen = false, right }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="hairline mb-px">
      <header className="metallic-head flex h-8 items-center gap-2 px-2 text-[10px] uppercase tracking-widest dim">
        <button onClick={() => setOpen(!open)} className="w-4 text-left text-white hover:text-[#00FF66]" title={open ? 'Collapse' : 'Expand'}>
          {open ? '▼' : '▶'}
        </button>
        <span>{title}</span>
        {!open && rollups && <span className="ml-auto flex gap-4 normal-case tracking-normal">{rollups.map(([k, v]) => <span key={k}><span className="dim">{k}</span> <span className="text-white">{v}</span></span>)}</span>}
        {open && right && <span className="ml-auto">{right}</span>}
      </header>
      {open && (
        <table className="w-max max-w-none text-left text-[11px]">
          <thead>
            <tr className="hairline-b dim text-[9px] uppercase tracking-widest">
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
        </table>
      )}
    </section>
  );
}

const Tip = ({ text, children }) => <span className="tt" data-tt={text}>{children}</span>;

/* ── pages ─────────────────────────────────────────────────────── */
function ProfitMetrics({ m }) {
  const recs = m.settled_records ?? [];
  const net = m.arb_settled_net_usd ?? 0;
  const kpis = [
    ['Settled Net P/L', fmt$(net), net >= 0 ? 'acc' : 'bad'],
    ['Settled Trades', m.settled_count ?? 0],
    ['Avg Net / Trade', m.settled_count ? fmt$(net / m.settled_count) : '—'],
    ['Best Trade', fmt$(Math.max(0, ...recs.map((r) => r.netUsd)))],
  ];
  return (<>
    <div className="grid grid-cols-4 gap-px bg-[#1A1A1A] mb-px">
      {kpis.map(([k, v, t]) => <div key={k} className="bg-[#050505] p-3"><div className="text-[9px] uppercase tracking-widest dim">{k}</div><div className={`mt-1 text-lg ${t ?? 'num'}`}>{v}</div></div>)}
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

function Strategy({ m, ops }) {
  const variants = Object.entries(m.variants ?? {});
  return (<>
    <div className="flex gap-3 p-3 text-[11px] border-b border-[#1A1A1A]">
      {Object.entries(ops.regimes ?? {}).map(([c, r]) => (
        <Tip key={c} text={`${c}: ${REGIME_HINT[r.regime] ?? ''}\nVol ${r.volBps?.toFixed(1)}bps · Trend ${r.trendScore?.toFixed(2)} · Illiq ${(r.illiquidFrac * 100).toFixed(0)}%`}>
          <span className={r.regime === 'BALANCED' ? 'dim' : r.regime === 'ILLIQUID_CRASH' ? 'bad' : 'acc'}>{c} · {r.regime?.replace(/_/g, ' ')}</span>
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
  const chainRows = Object.keys({ ...(m.pools ?? {}), ...(ops.regimes ?? {}) }).map((c) => {
    const cl = lanes.filter((l) => l.chain === c);
    return [c, m.pools?.[c] ?? 0, m.convicted?.[c] ?? 0, cl.length,
      cl.length ? <span className="num">{Math.round(cl.reduce((s, l) => s + l.p50Ms, 0) / cl.length)}ms</span> : '—',
      ops.regimes?.[c]?.regime?.replace(/_/g, ' ') ?? '—'];
  });
  return <Fold title="Chain Status Boards" cols={['Chain', 'Pools', 'Convicted', 'Lanes', 'P50', 'Regime']} defaultOpen
    rollups={[['Chains', chainRows.length], ['Pools', chainRows.reduce((s, r) => s + r[1], 0)], ['Lanes', chainRows.reduce((s, r) => s + r[3], 0)]]}
    rows={chainRows} />;
}

function Wallet({ ops }) {
  const w = ops.wallet ?? {};
  const row = (label, addr) => [
    label,
    addr ? <><span className="dim">{addr}</span> <button className="text-white hover:text-[#00FF66] ml-2" onClick={() => copy(addr)} title="Copy">⧉</button></> : <span className="dim">Not Configured</span>,
  ];
  return (<>
    <Fold title="Account Identities" cols={['Identity', 'Address']} defaultOpen rows={[row('Smart Account', w.smartAccount), row('Profit Wallet', w.profitWallet)]} />
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
  return (<>
    <Fold title="Runtime Parameters" cols={['Key', 'Value']} defaultOpen
      rollups={[['Params', rows.length], ['Mode', m.config?.autoExecute ? 'LIVE' : 'SHADOW']]}
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
      <div className="mb-4 flex items-center gap-3 text-[11px]">
        <Dot s={running} /> <span>{running ? `Runner Active — PID ${ops.engine?.pid}` : 'Runner Stopped'}</span>
        <span className="dim">·</span>
        <span className="warn">AUTO_EXECUTE Forced False — Shadow Only From UI</span>
      </div>
      <div className="flex gap-2">
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
  const [page, setPage] = useState('Profit Metrics');
  const [m, setM] = useState(null);
  const [ops, setOps] = useState({});
  const [wsUp, setWsUp] = useState(false);
  const [err, setErr] = useState(null);
  const wsRef = useRef(null);

  const pull = async () => {
    try {
      const [mr, or] = await Promise.all([fetch('/api/metrics'), fetch('/api/ops')]);
      setM(await mr.json()); setOps(await or.json()); setErr(null);
    } catch (e) { setErr(String(e)); }
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
    const t = setInterval(() => { if (!wsRef.current || wsRef.current.readyState !== 1) pull(); }, 3000);
    return () => { clearInterval(t); ws.close(); };
  }, []);

  if (err) return <div className="p-8 bad">Metrics Api Unreachable: {err}</div>;
  if (!m) return <div className="p-8 dim">Loading…</div>;

  const lanes = ops.lanes ?? [];
  const pageBody = {
    'Profit Metrics': <ProfitMetrics m={m} />,
    Strategy: <Strategy m={m} ops={ops} />,
    Chains: <Chains m={m} ops={ops} />,
    Wallet: <Wallet ops={ops} />,
    Infra: <Infra ops={ops} />,
    Deployment: <Deployment ops={ops} />,
    Configuration: <Configuration m={m} ops={ops} />,
    Engine: <Engine m={m} ops={ops} refresh={pull} />,
    Report: <Report m={m} ops={ops} />,
  }[page];

  return (
    <div className="min-h-screen">
      <nav className="metallic fixed left-0 top-0 z-40 flex h-screen w-36 flex-col">
        <div className="flex h-11 items-center gap-2 border-b border-[#1A1A1A] px-3">
          <img src="./logo.svg" className="h-5 w-5" alt="A" />
          <span className="text-[10px] font-bold tracking-widest">BANBOT</span>
        </div>
        {PAGES.map((p) => (
          <button key={p} onClick={() => setPage(p)}
            className={`flex h-9 items-center gap-2 border-b border-[#1A1A1A] px-3 text-left text-[10px] tracking-wide ${page === p ? 'acc bg-[#0F172A]' : 'dim hover:text-white'}`}>
            <span>{PAGE_ICON[p]}</span><span>{p}</span>
          </button>
        ))}
        <div className="mt-auto p-3 text-[9px] dim">
          <Dot s={wsUp} /> <span>{wsUp ? 'Ws Live' : 'Polling'}</span>
        </div>
      </nav>

      <main className="ml-36 pb-10">
        <header className="flex h-11 items-center justify-between border-b border-[#1A1A1A] px-4">
          <span className="text-[11px] tracking-widest">{page.toUpperCase()}</span>
          <span className={`text-[10px] tracking-widest ${m.config?.autoExecute ? 'acc' : 'warn'}`}>
            {m.config?.autoExecute ? 'LIVE EXECUTION' : 'SHADOW MODE'}
          </span>
        </header>
        <div className="p-px">{pageBody}</div>
      </main>

      <footer className="metallic fixed bottom-0 left-36 right-0 z-40 flex h-7 items-center gap-5 border-t border-slate-700/50 px-4 text-[10px]">
        {(() => {
          const rps = Object.values(ops.providers ?? {}).filter((p) => !/^SUSPENDED/.test(p.status ?? '')).reduce((s, p) => s + (p.safe_rps ?? 0), 0);
          return (<>
            <span className="tt" data-tt="Fleet"><span className="dim">Fleet</span> <span className="num">~{rps.toFixed(1)} Req/S</span></span>
            <span className="tt" data-tt="Lanes"><span className="dim">Lanes</span> <span className="num">{lanes.length}</span></span>
            <span className="tt" data-tt="Daemon"><span className="dim">Sync</span> <span className="text-white">{trunc(ops.daemon?.lastLine, 30)}</span></span>
            <span className="tt" data-tt="Engine"><span className="dim">Engine</span> <span className="num">{ops.engine?.running ? `PID ${ops.engine.pid}` : 'Off'}</span></span>
            <span className="ml-auto dim">AllBright © 2026</span>
          </>);
        })()}
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
