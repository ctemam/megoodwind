const { useEffect, useState } = React;

const fmt$ = (n) => `$${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function Card({ title, value, sub, tone = 'text-zinc-100' }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs uppercase tracking-wider text-zinc-500">{title}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function App() {
  const [m, setM] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    const pull = async () => {
      try {
        const r = await fetch('/api/metrics');
        setM(await r.json());
        setErr(null);
      } catch (e) {
        setErr(String(e));
      }
    };
    pull();
    const t = setInterval(pull, 3000);
    return () => clearInterval(t);
  }, []);

  if (err) return <div className="p-8 text-red-400">metrics API unreachable: {err}</div>;
  if (!m) return <div className="p-8 text-zinc-400">loading…</div>;

  const counters = Object.entries(m.counters ?? {});
  const profit = m.arb_settled_net_usd ?? 0;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">AllBright · Banbot Cockpit</h1>
        <span className="text-xs text-zinc-500">
          {m.config?.autoExecute ? 'LIVE EXECUTION' : 'SHADOW MODE'} · min profit ${m.config?.minProfitUsd}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card title="Settled net P/L" value={fmt$(profit)} tone={profit >= 0 ? 'text-emerald-400' : 'text-red-400'}
          sub="landed txs only — sims & probes excluded" />
        <Card title="Settled trades" value={m.settled_count ?? 0} />
        <Card title="Pools tracked" value={Object.values(m.pools ?? {}).reduce((a, b) => a + b, 0)} />
        <Card title="Bait convictions" value={Object.values(m.convicted ?? {}).reduce((a, b) => a + b, 0)} />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="mb-3 text-sm font-semibold text-zinc-300">Gate counters</h2>
          <table className="w-full text-left text-xs">
            <tbody>
              {counters.map(([k, v]) => {
                const [name, labels] = k.split('|');
                return (
                  <tr key={k} className="border-b border-zinc-800/60">
                    <td className="py-1 pr-2 font-mono text-zinc-400">{name}</td>
                    <td className="py-1 pr-2 text-zinc-500">{labels}</td>
                    <td className="py-1 text-right font-mono">{v}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="mb-3 text-sm font-semibold text-zinc-300">Variant scheduler</h2>
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr><th>id</th><th>emit</th><th>settled</th><th>revert</th><th className="text-right">net</th></tr>
            </thead>
            <tbody>
              {Object.entries(m.variants ?? {}).map(([id, s]) => (
                <tr key={id} className="border-b border-zinc-800/60 font-mono">
                  <td className="py-1">{id}</td>
                  <td>{s.emitted}</td>
                  <td>{s.settled}</td>
                  <td className={s.reverts ? 'text-red-400' : ''}>{s.reverts}</td>
                  <td className="text-right">{fmt$(s.netUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Recent settlements</h2>
        <table className="w-full text-left text-xs font-mono">
          <thead className="text-zinc-500">
            <tr><th>time</th><th>chain</th><th>strat</th><th>spread%</th><th className="text-right">net</th><th>tx</th></tr>
          </thead>
          <tbody>
            {(m.settled_records ?? []).slice(-15).reverse().map((r, i) => (
              <tr key={i} className="border-b border-zinc-800/60">
                <td className="py-1">{new Date(r.ts).toLocaleTimeString()}</td>
                <td>{r.chain}</td>
                <td>{r.strategy}</td>
                <td>{r.spreadPct.toFixed(2)}</td>
                <td className={`text-right ${r.netUsd >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt$(r.netUsd)}</td>
                <td className="max-w-[140px] truncate text-zinc-500">{r.txHash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
