const { useEffect, useState } = React;

const fmt$ = (n) => `$${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const trunc = (a, max = 14) => (a && a.length > max ? `${a.slice(0, Math.floor(max / 2))}…${a.slice(-Math.floor(max / 2))}` : a ?? '—');

/* ── micro-primitives ─────────────────────────────────────────── */
const Tip = ({ text, children }) => (
  <span className="tt" data-tt={text}>{children}</span>
);

const Dot = ({ s }) => <span className={`dot ${s === 'LIVE' || s === 'live' ? 'live' : /^SUSPENDED|dead/.test(s ?? '') ? 'dead' : 'armed'}`} />;

const REGIME_HINT = {
  HIGH_VOL_TRENDING: 'MEAN_REVERSION suppressed · MOMENTUM+CPV prioritized',
  LOW_VOL_MEAN_REVERTING: 'MOMENTUM+CPV suppressed · MEAN_REV+STAT_ARB prioritized',
  ILLIQUID_CRASH: 'STAT_ARB only · minDepth ≥$250k floor',
  BALANCED: 'all 12 variants eligible',
};

function Cell({ children, cls = '', tt }) {
  const el = <td className={`py-1.5 px-2 ${cls}`}>{children}</td>;
  return tt ? <td className={`py-1.5 px-2 tt ${cls}`} data-tt={tt}>{children}</td> : el;
}

/* ── sidebar: slim icon rail + live badges ────────────────────── */
function Sidebar({ laneCount, simCount, mode }) {
  const item = (icon, label, badge) => (
    <div className="tt flex h-10 w-full items-center justify-center border-b border-[#1A1A1A] text-sm dim hover:text-white"
         data-tt={label} style={{ cursor: 'default' }}>
      <span>{icon}</span>
      {badge != null && <span className="acc absolute ml-6 -mt-4 text-[9px] font-bold">{badge}</span>}
    </div>
  );
  return (
    <nav className="fixed left-0 top-0 z-40 flex h-screen w-11 flex-col border-r border-[#1A1A1A] bg-[#050505]">
      <div className="flex h-12 items-center justify-center border-b border-[#1A1A1A]">
        <img src="./logo.svg" className="h-5 w-5" alt="A" />
      </div>
      {item('◈', `RPC LANES — ${laneCount} live endpoints`, laneCount)}
      {item('⟁', `SIMULATION — ${simCount} fork dry-runs logged`, simCount || 'SIM')}
      {item('∿', 'REGIME — market conditioning active')}
      {item('▤', 'POOLS — discovered venue universe')}
      <div className="mt-auto pb-2 text-center">
        <span className={`dot ${mode === 'live' ? 'live' : 'armed'}`} data-tt={mode} />
      </div>
    </nav>
  );
}

/* ── status ribbon: flat bottom bar ───────────────────────────── */
function Ribbon({ m, ops }) {
  const rps = Object.values(ops.providers ?? {})
    .filter((p) => !/^SUSPENDED/.test(p.status ?? ''))
    .reduce((s, p) => s + (p.safe_rps ?? 0), 0);
  const items = [
    ['fleet', `~${rps.toFixed(1)} req/s`],
    ['mode', m.config?.autoExecute ? 'LIVE' : 'SHADOW'],
    ['floor', `$${m.config?.minProfitUsd}`],
    ['sync', ops.daemon?.lastLine ? trunc(ops.daemon.lastLine, 40) : 'idle'],
    ['signals', Object.values(ops.signals ?? {}).reduce((s, x) => s + x.records, 0)],
  ];
  return (
    <footer className="fixed bottom-0 left-11 right-0 z-40 flex h-7 items-center gap-6 border-t border-[#1A1A1A] bg-[#050505] px-4 text-[10px] dim">
      {items.map(([k, v]) => (
        <span key={k} className="tt" data-tt={k.toUpperCase()}>
          <span className="dim">{k}</span> <span className="text-white">{String(v)}</span>
        </span>
      ))}
      <span className="ml-auto dim">AllBright DeFi © 2026</span>
    </footer>
  );
}

/* ── main ─────────────────────────────────────────────────────── */
function App() {
  const [m, setM] = useState(null);
  const [ops, setOps] = useState({});
  const [err, setErr] = useState(null);

  useEffect(() => {
    const pull = async () => {
      try {
        const [mr, or] = await Promise.all([fetch('/api/metrics'), fetch('/api/ops')]);
        setM(await mr.json());
        setOps(await or.json());
        setErr(null);
      } catch (e) { setErr(String(e)); }
    };
    pull();
    const t = setInterval(pull, 3000);
    return () => clearInterval(t);
  }, []);

  if (err) return <div className="p-8 bad">metrics API unreachable: {err}</div>;
  if (!m) return <div className="p-8 dim">loading…</div>;

  const counters = Object.entries(m.counters ?? {});
  const profit = m.arb_settled_net_usd ?? 0;
  const lanes = ops.lanes ?? [];
  const providers = ops.providers ?? {};
  const simCount = (ops.simLedger ?? []).length;

  const kpi = (label, value, tone = '', tt) => (
    <div className="hairline p-3 tt" data-tt={tt || label}>
      <div className="text-[9px] uppercase tracking-widest dim">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  );

  return (
    <div className="min-h-screen">
      <Sidebar laneCount={lanes.length} simCount={simCount} mode={m.config?.autoExecute ? 'live' : 'armed'} />

      <main className="ml-11 mr-0 pb-12">
        {/* header — no waste */}
        <header className="flex h-12 items-center justify-between border-b border-[#1A1A1A] px-4">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold tracking-widest">BANBOT</span>
            <span className="dim text-[10px]">autonomous wealth engine · 24/7</span>
          </div>
          <span className={`text-[10px] tracking-widest ${m.config?.autoExecute ? 'acc' : 'warn'}`}>
            {m.config?.autoExecute ? 'LIVE EXECUTION' : 'SHADOW MODE'}
          </span>
        </header>

        <div className="grid grid-cols-4 gap-px bg-[#1A1A1A] border-b border-[#1A1A1A]">
          {kpi('settled net p/l', fmt$(profit), profit >= 0 ? 'acc' : 'bad', 'landed txs only — sims & probes excluded')}
          {kpi('settled trades', m.settled_count ?? 0, '', 'count of landed arb settlements')}
          {kpi('pools tracked', Object.values(m.pools ?? {}).reduce((a, b) => a + b, 0), '', 'discovered on-chain — never hand-registered')}
          {kpi('convictions', Object.values(m.convicted ?? {}).reduce((a, b) => a + b, 0), '', 'bait/scam pool convictions — forensics')}
        </div>

        <div className="grid grid-cols-2 gap-px bg-[#1A1A1A] border-b border-[#1A1A1A]">
          {/* RPC lanes — heavy metadata behind hover */}
          <section className="bg-[#050505] p-3">
            <h2 className="mb-2 text-[10px] uppercase tracking-widest dim">rpc lanes</h2>
            <table className="w-full text-left text-[11px]">
              <tbody>
                {Object.entries(providers).map(([id, p]) => {
                  const lane = lanes.filter((l) => l.provider === id);
                  const p50 = lane.length ? Math.round(lane.reduce((s, l) => s + l.p50Ms, 0) / lane.length) : null;
                  const status = p.status ?? 'UNKNOWN';
                  const tt = [
                    `status: ${status}`,
                    `safe_rps: ${p.safe_rps}`, `daily_budget: ${(p.daily_budget ?? 0).toLocaleString()}`,
                    `chains: ${(p.supported_chains ?? []).join(',')}`,
                    lane.length ? `p50: ${p50}ms · p95: ${Math.round(lane.reduce((s, l) => s + l.p95Ms, 0) / lane.length)}ms · lanes: ${lane.length}` : 'no benchmark yet',
                  ].join('\n');
                  return (
                    <tr key={id} className="hairline-b">
                      <td className="py-1.5 px-2 w-4"><Dot s={status} /></td>
                      <td className="py-1.5 px-2 tt" data-tt={tt}>{id}</td>
                      <td className="py-1.5 px-2 text-right dim">{p50 ? `${p50}ms` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {/* regime + variants */}
          <section className="bg-[#050505] p-3">
            <h2 className="mb-2 text-[10px] uppercase tracking-widest dim">regime · variants</h2>
            <div className="mb-2 flex gap-3 text-[11px]">
              {Object.entries(ops.regimes ?? {}).map(([c, r]) => (
                <Tip key={c} text={`${c}: ${REGIME_HINT[r.regime] ?? ''}\nvol ${r.volBps?.toFixed(1)}bps · trend ${r.trendScore?.toFixed(2)} · illiq ${(r.illiquidFrac * 100).toFixed(0)}%`}>
                  <span className={r.regime === 'BALANCED' ? 'dim' : r.regime === 'ILLIQUID_CRASH' ? 'bad' : 'acc'}>
                    {c}·{r.regime?.replace(/_/g, ' ')}
                  </span>
                </Tip>
              ))}
              {!Object.keys(ops.regimes ?? {}).length && <span className="dim text-[10px]">no regime records — runner idle</span>}
            </div>
            <table className="w-full text-left text-[11px]">
              <tbody>
                {Object.entries(m.variants ?? {}).map(([id, s]) => (
                  <tr key={id} className="hairline-b tt" data-tt={`emit ${s.emitted} · settled ${s.settled} · reverts ${s.reverts} · ewma ${Math.round(s.ewmaLatencyMs ?? 0)}ms`}>
                    <td className="py-1.5 px-2">{id}</td>
                    <td className="py-1.5 px-2 dim">{s.emitted}/{s.settled}</td>
                    <td className={`py-1.5 px-2 text-right ${s.netUsd >= 0 ? 'acc' : 'bad'}`}>{fmt$(s.netUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        {/* sim ledger — impersonation dry-runs */}
        <section className="border-b border-[#1A1A1A] p-3">
          <h2 className="mb-2 text-[10px] uppercase tracking-widest dim">impersonation ledger — fork dry-runs</h2>
          <table className="w-full text-left text-[11px]">
            <tbody>
              {(ops.simLedger ?? []).map((r, i) => (
                <tr key={i} className="hairline-b tt"
                    data-tt={`legs: ${(r.candidate?.legs ?? []).join(' > ')}\nborrow: ${r.candidate?.borrowToken ?? '—'} ${r.candidate?.borrowAmount ?? ''}\nnetUsd: ${fmt$(r.candidate?.netUsd)}`}>
                  <td className="py-1.5 px-2 w-16 dim">{new Date(r.ts).toLocaleTimeString()}</td>
                  <td className="py-1.5 px-2 w-14">{r.chain}</td>
                  <td className="py-1.5 px-2 w-14 dim">{r.candidate?.strategy}</td>
                  <td className="py-1.5 px-2 dim">{trunc(r.candidate?.legs?.[0]?.split(':')[1])}</td>
                  <td className={`py-1.5 px-2 text-right ${r.sim?.status === 'PASS' ? 'acc' : r.sim?.status ? 'bad' : 'dim'}`}>
                    {r.sim?.status ?? r.sim?.sim_gate ?? '—'}{r.sim?.gasUsed ? ` · ${Number(r.sim.gasUsed).toLocaleString()}gas` : ''}
                  </td>
                </tr>
              ))}
              {!(ops.simLedger ?? []).length && (
                <tr><td className="py-2 dim text-[10px]">no dry-runs yet — monitor emits here (anvil_impersonateAccount → executor.exec)</td></tr>
              )}
            </tbody>
          </table>
        </section>

        {/* settlements — the honesty table */}
        <section className="p-3">
          <h2 className="mb-2 text-[10px] uppercase tracking-widest dim">settled — landed only</h2>
          <table className="w-full text-left text-[11px]">
            <tbody>
              {(m.settled_records ?? []).slice(-15).reverse().map((r, i) => (
                <tr key={i} className="hairline-b tt" data-tt={`tx: ${r.txHash}`}>
                  <td className="py-1.5 px-2 w-16 dim">{new Date(r.ts).toLocaleTimeString()}</td>
                  <td className="py-1.5 px-2 w-14">{r.chain}</td>
                  <td className="py-1.5 px-2 w-14 dim">{r.strategy}</td>
                  <td className="py-1.5 px-2">{r.spreadPct.toFixed(2)}%</td>
                  <td className={`py-1.5 px-2 text-right ${r.netUsd >= 0 ? 'acc' : 'bad'}`}>{fmt$(r.netUsd)}</td>
                </tr>
              ))}
              {!(m.settled_records ?? []).length && (
                <tr><td className="py-2 dim text-[10px]">no landed settlements — shadow mode</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </main>

      <Ribbon m={m} ops={ops} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
