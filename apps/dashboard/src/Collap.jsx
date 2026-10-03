import React, { useState } from 'react'

// Collapsible section — title bar with chevron toggle + optional right-side
// extras that stay visible while collapsed. `bare` renders without panel
// chrome for nesting inside an existing .panel.
export default function Collap({ title, extra, open = true, bare = false, style, children }) {
  const [on, setOn] = useState(open)
  return (
    <div className={bare ? 'collap-bare' : 'panel'} style={style}>
      <div className="collap-head" onClick={() => setOn(o => !o)}>
        <span className={`collap-car ${on ? 'on' : ''}`}>▸</span>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <div className="collap-extra" onClick={e => e.stopPropagation()}>{extra}</div>
      </div>
      {on && <div className="collap-body">{children}</div>}
    </div>
  )
}
