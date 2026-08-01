//   TabBar — segmented tab control. Token-driven (design "Primitives → TAB BAR").
//   Container: --surface-trough + border, r-* 12. Active: --surface-inset + inset teal ring.

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
        borderRadius: 12,
        background: 'var(--surface-trough)',
        border: '1px solid rgba(var(--border-rgb), 0.1)',
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
              borderRadius: 9,
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: on ? 700 : 600,
              background: on ? 'var(--surface-inset)' : 'transparent',
              color: on ? 'var(--text-bright)' : 'var(--text-muted-dim)',
              boxShadow: on ? 'inset 0 0 0 1px rgba(var(--teal-500-rgb), 0.22)' : 'none',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
