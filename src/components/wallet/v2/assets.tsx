// The assets list — the portfolio, as far as it currently goes.
//
// ── ONE REAL ASSET, PRESENTED AS A LIST ──────────────────────────────────────
//
// Caravel holds exactly one token. TARI_RESOURCE_ADDRESS is hardwired at 41 sites under
// src/crypto, the scan decrypts one resource, and the revealed read looks in one vault. So there is
// no multi-asset MODEL here and this file does not pretend otherwise: it takes the same total the
// hero takes and lays it out as the first row of a list that will grow.
//
// That distinction is worth keeping sharp. A row per asset is a presentation; a portfolio is a data
// model with per-resource scanning, per-resource ceilings and per-resource settle watches. Building
// the second one to satisfy the first would be a large change to the parts of the wallet that move
// money, for a screen that today has one row on it.
//
// ── WHAT V3 REMOVED ──────────────────────────────────────────────────────────
//
// The row used to carry a shielded/unshielded sub-line, and the card used to end with a "Wrapped
// XTM · coming soon" row and a dashed "more assets coming" note. All three are gone.
//
// The sub-line went because the Privacy card directly above now states the split properly — with a
// bar, both figures, and per-side status — so repeating a squashed version of it here was the same
// fact twice, in less detail, where it read as a different fact. The other two went because they
// were the screen advertising its own roadmap: two rows of furniture above the user's actual
// activity, neither of which they can do anything with.
//
// ── THE HONESTY RULES STILL APPLY ────────────────────────────────────────────
//
// The row's figure goes through the same `fiatForTotal` / `totalPillValue` pair the hero and the
// service rail use, so a settling or unreadable total cannot become a confident number here just
// because the type is smaller. When there is no figure the row shows `···` or `—`, muted, and the
// Privacy card above says which half is the reason.

import { RowBleed } from './panels'
import { C, MONO } from './tokens'
import { fiatForTotal } from './fiat'
import { fmt6 } from './format'
import { totalPillValue } from './TotalHero'
import type { TotalView } from './total'

export interface AssetsPanelProps {
  /** The row's right-hand figure. Same union, same rules, as the hero's. */
  total: TotalView
  hidden: boolean
  /**
   * Opens the asset's own page.
   *
   * OPTIONAL, AND THE AFFORDANCE FOLLOWS IT. When no handler is passed the row renders inert — no
   * chevron, no pointer, no hover. A row that looked clickable and did nothing would be a dead
   * control, which is worse than one not yet offered.
   */
  onOpen?: () => void
  /**
   * A SECTION OF THE OVERVIEW CARD rather than a card of its own — see panels/OverviewCard.
   *
   * Bare drops the border, the ground and the shadow; the card around it draws all three. What
   * replaces the 5px of padding is the row bleed, which does the same job from the other side —
   * it gives the row's hover band room to run wider than the text it contains.
   */
  bare?: boolean
}

export function AssetsPanel({ total, hidden, onOpen, bare = false }: AssetsPanelProps) {
  const live = !!onOpen

  const row = (
      <div
        role={live ? 'button' : undefined}
        tabIndex={live ? 0 : undefined}
        onClick={onOpen}
        onKeyDown={live ? (e => e.key === 'Enter' && onOpen()) : undefined}
        className={live ? 'cv-asset-row' : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          // 13 and 9, which are the activity row's numbers too. They were 12 and 10 here for no
          // reason anyone recorded, and two lists of rows in one card have to agree.
          padding: '11px 13px', borderRadius: 9,
          cursor: live ? 'pointer' : 'default',
        }}
      >
        <img
          src="/partner-tari.jpg" alt="" aria-hidden="true"
          style={{
            width: 32, height: 32, borderRadius: 10, objectFit: 'cover',
            border: '1px solid var(--border)', flexShrink: 0, display: 'block',
          }}
        />
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: C.primary }}>XTR</span>
        <span style={{ textAlign: 'right', flexShrink: 0 }}>
          <span style={{
            display: 'block', fontSize: 13, fontWeight: 600, fontFeatureSettings: "'tnum'",
            // Bright only when the figure is a fact. `···` and `—` stay muted, so the row can never
            // look like it is reporting a holding it is in fact refusing to state.
            color: hidden || total.status === 'ready' ? C.primary : C.mutedDim,
          }}>
            {/* The dollar figure only exists when the balance does; otherwise this is the same
                `···` / `—` the hero and the rail show, and there is nothing to price. */}
            {hidden ? totalPillValue(total, hidden) : fiatForTotal(total) ?? totalPillValue(total, hidden)}
          </span>
          {!hidden && total.status === 'ready' && (
            <span style={{
              display: 'block', fontFamily: MONO, fontSize: 11,
              color: C.mutedDim, marginTop: 2, whiteSpace: 'nowrap',
            }}>{fmt6(total.microtari)} XTR</span>
          )}
        </span>
        {live && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M9 18l6-6-6-6" />
          </svg>
        )}
      </div>
  )

  if (bare) return <RowBleed>{row}</RowBleed>
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 14, padding: 5, boxShadow: 'var(--e1)',
    }}>{row}</div>
  )
}
