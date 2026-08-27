//   TabBar — segmented tab control. Token-driven (design "Primitives → TAB BAR").
//   Container: --surface-trough + border, radius md. Active: --nav-selected, the foundation's
//   selected-nav treatment — a filled row, no ring.

import type { CSSProperties } from 'react'

export interface Tab {
  id: string
  label: string
}

interface TabBarProps {
  tabs: Tab[]
  active: string
  onChange: (id: string) => void
  style?: CSSProperties
}

export default function TabBar({ tabs, active, onChange, style }: TabBarProps) {
  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        gap: 4,
        padding: 5,
        borderRadius: 'var(--r-md)',
        background: 'var(--surface-trough)',
        border: '1px solid var(--border)',
        ...style,
      }}
    >
      {tabs.map((t) => {
        const on = t.id === active
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            style={{
              flex: 1,
              textAlign: 'center',
              padding: '9px 0',
              borderRadius: 'var(--r-md)',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: on ? 600 : 500,
              background: on ? 'var(--nav-selected)' : 'transparent',
              color: on ? 'var(--text-bright)' : 'var(--text-muted)',
              boxShadow: 'none',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
