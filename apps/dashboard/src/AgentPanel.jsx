import React, { useEffect, useRef, useState } from 'react'

// Read-only AI ops copilot drawer. Chat + monitoring feed on top;
// model management at the bottom (OpenAI-compatible endpoints).
export default function AgentPanel({ open, onClose }) {
  const [models, setModels] = useState([])
  const [modelId, setModelId] = useState('')
  const [feed, setFeed] = useState([])
  const [msgs, setMsgs] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ name: '', base_url: '', model: '', api_key: '' })
  const endRef = useRef(null)

  const load = async () => {
    try {
      const [m, f] = await Promise.all([
        fetch('/api/agent/models').then(r => r.json()),
        fetch('/api/agent/feed').then(r => r.json()),
      ])
      setModels(m)
      if (!modelId && m.length) setModelId(m[0].id)
      setFeed(f)
    } catch {}
  }
  useEffect(() => { if (open) { load(); const t = setInterval(load, 30000); return () => clearInterval(t) } }, [open])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, feed])

  const send = async e => {
    e.preventDefault()
    const q = input.trim(); if (!q) return
    const next = [...msgs, { role: 'user', text: q }]
    setMsgs(next); setInput(''); setBusy(true)
    try {
      const r = await fetch('/api/agent/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model_id: modelId, messages: next.slice(-10).map(m => ({ role: m.role, content: m.text })) }),
      })
      const j = await r.json()
      setMsgs([...next, { role: 'assistant', text: j.text || `⚠ ${j.error}`, model: j.model }])
    } catch (err) { setMsgs([...next, { role: 'assistant', text: `⚠ ${err.message}` }]) }
    setBusy(false)
  }

  const addModel = async e => {
    e.preventDefault()
    const r = await fetch('/api/agent/models', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) })
    const j = await r.json()
    if (j.id) { setForm({ name: '', base_url: '', model: '', api_key: '' }); setAddOpen(false); load() }
  }

  const timeline = [
    ...feed.map(f => ({ role: 'monitor', text: f.text, t: f.t, model: null })),
    ...msgs.map(m => ({ ...m, t: 0 })),
  ]

  return (
    <div className={`agent-drawer ${open ? 'open' : ''}`}>
      <div className="agent-head">
        <b>◆ Ops Copilot</b>
        <span className="dim" style={{ fontSize: 11 }}>read-only monitoring</span>
        <button className="agent-x" onClick={onClose}>×</button>
      </div>

      <div className="agent-body">
        {timeline.length === 0 && (
          <div className="agent-msg assistant">
            Fleet nominal — no anomalies reported. Ask about status, capacity, profit, or alerts. I monitor runners, scans, hits, and expansion bands every 60s.
          </div>
        )}
        {timeline.map((m, i) => (
          <div key={i} className={`agent-msg ${m.role}`}>
            {m.role === 'monitor' && <div className="agent-tag">monitor · {new Date(m.t).toLocaleTimeString()}</div>}
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
            {m.model && <div className="agent-tag">via {m.model}</div>}
          </div>
        ))}
        {busy && <div className="agent-msg assistant dim">thinking…</div>}
        <div ref={endRef} />
      </div>

      <form className="agent-input" onSubmit={send}>
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask the fleet…" />
        <button className="primary" disabled={busy}>→</button>
      </form>

      {/* Model management — lower side of the panel */}
      <div className="agent-models">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select value={modelId} onChange={e => setModelId(e.target.value)} style={{ flex: 1 }}>
            <option value="">local rules (no model)</option>
            {models.map(m => <option key={m.id} value={m.id}>{m.name} — {m.model}</option>)}
          </select>
          <button type="button" onClick={() => setAddOpen(o => !o)}>{addOpen ? '−' : '+ model'}</button>
        </div>
        {addOpen && (
          <form className="agent-addform" onSubmit={addModel}>
            <input placeholder="name (e.g. GPT-4o)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            <input placeholder="base url (https://api.openai.com/v1)" value={form.base_url} onChange={e => setForm({ ...form, base_url: e.target.value })} />
            <input placeholder="model (gpt-4o / llama3.1 / claude…)" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} />
            <input placeholder="api key (stored on this box only)" type="password" value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })} />
            <button className="primary" type="submit">Add model</button>
          </form>
        )}
      </div>
    </div>
  )
}
