import React, { useMemo, useState } from 'react'

// Shared sortable-table wiring — the Wallet Intelligence pattern applied
// everywhere. useSort(rows, [key, dir]) -> [sorted, th]; th(key,label) is a
// clickable <th>. Nulls sort last; strings compare lexically, else numeric.
export function useSort(rows, initial = [null, -1]) {
  const [sort, setSort] = useState(initial)
  const sorted = useMemo(() => {
    const [k, dir] = sort
    if (!k) return rows
    return rows.slice().sort((a, b) => {
      const va = a[k], vb = b[k]
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      return (va > vb ? 1 : va < vb ? -1 : 0) * dir
    })
  }, [rows, sort])
  const th = (key, label, extra) => (
    <th key={key} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      onClick={() => setSort(s => [key, s[0] === key ? -s[1] : -1])}>
      {label}{sort[0] === key ? (sort[1] < 0 ? ' ▾' : ' ▴') : ''}{extra}
    </th>
  )
  return [sorted, th, sort]
}
