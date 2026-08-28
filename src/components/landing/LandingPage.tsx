//   Landing page — the public marketing page, built to the "Caravel Landing Page" design.
//
//   ── THEMING ──────────────────────────────────────────────────────────────────
//
//   The toggle here drives the APP-WIDE theme, held by hooks/useTheme and written to <html>. The
//   attribute on this page's root div is kept only so the scoped .cv-lp rules below can key off it;
//   it mirrors the app's value rather than owning one.
//
//   The choice PERSISTS and is APP-WIDE (see hooks/useTheme): a visitor who picks dark here is still
//   in dark at the unlock screen and in the wallet behind it.
//
//   ── RESPONSIVE ───────────────────────────────────────────────────────────────
//
//   The design is a fixed 1120 desktop canvas with no media queries of its own — four-, three- and
//   two-column grids that overflow below roughly 900px. Everything layout-changing (grid columns,
//   section rhythm, the display sizes, the mockup's rail) therefore lives in the scoped .cv-lp
//   classes below so the two breakpoints can override it; colours and decorative offsets stay
//   inline, exactly as the previous landing page was arranged.
//
//   The app mockup narrows rather than scales. Its internals are fixed pixels, so a transform would
//   need a paired negative margin to keep layout height in step — fiddly, and it makes the type
//   blurry on the way down. Dropping the nav rail below 880 instead lets the right pane, which is
//   already fluid, simply take the width. The rail is decoration here; the balance card is the point.

import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../../hooks/useTheme'
import ThemeToggle from '../primitives/ThemeToggle'

// ── Icons ─────────────────────────────────────────────────────────────────────
//
// Transcribed from the design. `currentColor` throughout so a caller sets the colour once on the
// parent; the two that take an explicit colour do so because they sit on the navy vault, where the
// surrounding text colour is not the one the icon wants.

type IconProps = { size?: number; color?: string; strokeWidth?: number }

const svgBase = (size: number, color: string, strokeWidth: number) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  style: { flexShrink: 0 },
})

const Wallet = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><rect x="2.5" y="6" width="19" height="13" rx="2.5" /><path d="M2.5 10h19" /><path d="M15.5 14.5h2" /></svg>
)
const Message = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M21 11.5a8.5 8.5 0 1 0-16.9 1.6L3 20l3.8-1.1A8.5 8.5 0 0 0 21 11.5z" /></svg>
)
const AtSign = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></svg>
)
/** Shielded. A closed padlock — the design's private/confidential mark. */
const Lock = ({ size = 16, color = 'currentColor', strokeWidth = 2 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
)
/** Unshielded. An open eye — visible on chain. */
const Eye = ({ size = 16, color = 'currentColor', strokeWidth = 2 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="3" /></svg>
)
const ArrowOut = ({ size = 16, color = 'currentColor', strokeWidth = 2 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M7 17L17 7" /><path d="M9 7h8v8" /></svg>
)
const Browser = ({ size = 18, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18" /><circle cx="6" cy="6.5" r=".5" /><circle cx="8.5" cy="6.5" r=".5" /></svg>
)
const Key = ({ size = 18, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><circle cx="8" cy="15" r="4.5" /><path d="M11 12L20 3M16 7l3 3M13 10l2.5 2.5" /></svg>
)
const Swap = ({ size = 15, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M4 7h13l-3-3" /><path d="M20 17H7l3 3" /></svg>
)
const Bridge = ({ size = 15, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M2 17h20" /><path d="M4 17v-4a8 8 0 0 1 16 0v4" /></svg>
)
const Pools = ({ size = 15, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><circle cx="12" cy="7.5" r="3.2" /><circle cx="7.5" cy="15.5" r="3.2" /><circle cx="16.5" cy="15.5" r="3.2" /></svg>
)
const Plus = ({ size = 11, color = 'currentColor', strokeWidth = 2 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M12 5v14M5 12h14" /></svg>
)
const Chevron = ({ size = 16, color = 'currentColor', dir = 'down' }: IconProps & { dir?: 'up' | 'down' }) => (
  <svg {...svgBase(size, color, 2)}>{dir === 'up' ? <path d="M18 15l-6-6-6 6" /> : <path d="M6 9l6 6 6-6" />}</svg>
)
const ChevronRight = ({ size = 11, color = 'currentColor', strokeWidth = 2 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M9 18l6-6-6-6" /></svg>
)

// ── Small shared pieces ───────────────────────────────────────────────────────

/**
 * The brand lockup: the light mark inside an accent tile, then the wordmark.
 *
 * One rendering in both themes, deliberately. The foundation allows the blue mark on light and the
 * light mark on the vault — and the tile IS a vault-coloured surface, so the light mark is correct
 * whichever theme the page is in. It also keeps the lockup identical to the app's nav rail.
 */
function Lockup({ tile, mark, text }: { tile: number; mark: number; text: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: tile > 28 ? 10 : 9 }}>
      <span style={{
        width: tile, height: tile, borderRadius: tile > 28 ? 9 : 8, background: 'var(--accent-400)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <img src="/logo-light.png" alt="" aria-hidden="true" style={{ height: mark, width: 'auto', display: 'block' }} />
      </span>
      <span style={{ fontSize: text, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>Caravel</span>
    </div>
  )
}

/** The primary CTA. One definition — it appears in the top bar, the hero and the closing section. */
function LaunchButton({ onClick, big = false }: { onClick: () => void; big?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="cv-lp-primary"
      style={{
        cursor: 'pointer', fontFamily: 'inherit', border: 'none',
        padding: big ? '13px 26px' : '10px 18px', borderRadius: 'var(--r-md)',
        fontSize: big ? 15 : 14, fontWeight: 600,
        background: 'var(--accent-400)', color: '#FFFFFF',
      }}
    >Launch Caravel</button>
  )
}

/** Section heading. 38/600 on desktop; the class carries the two smaller steps. */
function H2({ children, narrow = false }: { children: React.ReactNode; narrow?: boolean }) {
  return (
    <h2 className="cv-lp-h2" style={{
      margin: '0 auto', textAlign: 'center', fontWeight: 600, letterSpacing: '-0.025em',
      lineHeight: 1.15, color: 'var(--text-primary)', textWrap: 'pretty',
      ...(narrow ? { maxWidth: 720 } : {}),
    }}>{children}</h2>
  )
}

/** "Live" / "Coming soon" / "BACKER" — the design's three pill treatments. */
function Pill({ tone, children }: { tone: 'live' | 'quiet' | 'mono'; children: React.ReactNode }) {
  if (tone === 'live') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
        borderRadius: 'var(--r-pill)', background: 'rgba(var(--positive-rgb),0.12)',
        color: 'var(--positive)', fontSize: 11.5, fontWeight: 600, flexShrink: 0,
      }}>
        <span style={{ width: 5, height: 5, borderRadius: 'var(--r-pill)', background: 'var(--positive)' }} />
        {children}
      </span>
    )
  }
  if (tone === 'mono') {
    return (
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.14em',
        color: 'var(--text-muted-dim)', padding: '5px 12px', borderRadius: 'var(--r-pill)',
        border: '1px solid var(--border)',
      }}>{children}</span>
    )
  }
  return (
    <span style={{
      padding: '3px 9px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border)',
      fontSize: 11, fontWeight: 600, color: 'var(--text-muted-dim)', flexShrink: 0,
    }}>{children}</span>
  )
}

// ── The app mockup ────────────────────────────────────────────────────────────
//
// A still of the product, not a live embed. Every figure is a literal chosen to match the design;
// nothing here reads real state, and it deliberately does not import anything from the wallet — a
// marketing still that could break when the wallet's types move would be the worst of both.
//
// TERMINOLOGY: Shielded / Unshielded, and XTR. Product-wide vocabulary as of the v0.3 rebrand.

const VAULT_LABEL = { fontSize: 11.5, fontWeight: 500, color: 'var(--vault-label)' } as const
const VAULT_NUM = { fontWeight: 600, color: '#FFFFFF', fontFeatureSettings: "'tnum'" } as const

function BalanceSide({ kind, amount }: { kind: 'shielded' | 'unshielded'; amount: string }) {
  const Icon = kind === 'shielded' ? Lock : Eye
  return (
    <div style={{ background: 'var(--vault-card)', borderRadius: 9, padding: '9px 11px', textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon size={10} color="var(--vault-label)" />
        <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--navy-200)' }}>
          {kind === 'shielded' ? 'Shielded' : 'Unshielded'}
        </span>
      </div>
      <div style={{ ...VAULT_NUM, fontSize: 13, marginTop: 3 }}>{amount}</div>
    </div>
  )
}

function RailItem({ icon, label, active = false }: { icon: React.ReactNode; label: string; active?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 9,
      background: active ? 'var(--nav-selected)' : 'transparent',
      color: active ? '#FFFFFF' : 'var(--navy-200)',
      fontSize: 12, fontWeight: active ? 600 : 500,
    }}>{icon}{label}</div>
  )
}

function AppMockup() {
  return (
    <div className="cv-lp-mock" style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-xl)',
      boxShadow: 'var(--e3)', overflow: 'hidden', textAlign: 'left',
    }}>
      {/* Browser chrome */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
        {[0, 1, 2].map(i => <span key={i} style={{ width: 9, height: 9, borderRadius: 'var(--r-pill)', background: 'var(--border)' }} />)}
      </div>

      <div style={{ display: 'flex' }}>
        {/* Service rail — hidden below 880; see the responsive note at the top of this file. */}
        <div className="cv-lp-rail" style={{
          width: 190, flexShrink: 0, background: 'var(--nav-ground)', padding: '16px 12px',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ padding: '4px 8px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--accent-400)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <img src="/logo-light.png" alt="" aria-hidden="true" style={{ height: 13, width: 'auto', display: 'block' }} />
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: '#FFFFFF' }}>Caravel</span>
            </div>
          </div>
          <div style={{ background: 'var(--vault-card)', borderRadius: 'var(--r-md)', padding: '10px 12px', marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--vault-label)' }}>Total balance</div>
            <div style={{ ...VAULT_NUM, fontSize: 15, marginTop: 2 }}>$340.00</div>
          </div>
          <RailItem icon={<Wallet size={13} />} label="Wallet" active />
          <RailItem icon={<Message size={13} />} label="Chat" />
          <RailItem icon={<AtSign size={13} />} label="Name" />
          <div style={{ flex: 1, minHeight: 16 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderTop: '1px solid var(--border)' }}>
            <span style={{ width: 22, height: 22, borderRadius: 7, background: 'var(--vault-card)', color: 'var(--accent-300)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>@</span>
            <span style={{ flex: 1, fontSize: 11.5, fontWeight: 600, color: '#F2F6FA', minWidth: 0 }}>@okz61</span>
            <Lock size={12} color="var(--vault-label)" />
          </div>
        </div>

        {/* Wallet pane */}
        <div style={{ flex: 1, padding: '20px 24px 24px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', flex: 1, color: 'var(--text-primary)' }}>Wallet</span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px',
              borderRadius: 'var(--r-pill)', border: '1px solid var(--border)',
              fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.08em', color: 'var(--text-muted-dim)', whiteSpace: 'nowrap',
            }}>
              <span style={{ width: 4, height: 4, borderRadius: 'var(--r-pill)', background: 'var(--warn)' }} />ESMERALDA TESTNET
            </span>
            <span style={{ width: 26, height: 26, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-body-dim)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Eye size={12} />
            </span>
          </div>

          {/* The vault. Navy in both themes — the balance hero does not follow the page theme. */}
          <div style={{ background: 'var(--nav-ground)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 18, marginTop: 12 }}>
            <div style={{ ...VAULT_LABEL, textAlign: 'left' }}>Total balance</div>
            <div style={{ ...VAULT_NUM, fontSize: 30, fontWeight: 700, letterSpacing: '-0.03em', marginTop: 4, textAlign: 'left' }}>$340.00</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
              <BalanceSide kind="shielded" amount="$250.00" />
              <BalanceSide kind="unshielded" amount="$90.00" />
            </div>
            <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
              <span style={{ flex: 1, textAlign: 'center', padding: '8px 6px', borderRadius: 8, fontSize: 11.5, fontWeight: 600, background: 'var(--accent-400)', color: '#FFFFFF' }}>Send</span>
              <span style={{ flex: 1, textAlign: 'center', padding: '8px 6px', borderRadius: 8, fontSize: 11.5, fontWeight: 600, background: 'var(--vault-card)', color: '#FFFFFF' }}>Receive</span>
            </div>
          </div>

          {/* Assets */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 5, marginTop: 10, boxShadow: 'var(--e1)' }}>
            <div style={{ padding: '8px 11px 5px', fontSize: 11.5, fontWeight: 600, textAlign: 'left', color: 'var(--text-primary)' }}>Assets</div>
            <div className="cv-lp-asset" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 11px' }}>
              <span style={{ width: 28, height: 28, borderRadius: 9, overflow: 'hidden', border: '1px solid var(--border)', flexShrink: 0 }}>
                <img src="/partner-tari.jpg" alt="" aria-hidden="true" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              </span>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>XTR</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 1, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted-dim)', flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Lock size={8} />625,000.000000</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Eye size={8} />225,000.000000</span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 12, fontWeight: 600, fontFeatureSettings: "'tnum'", color: 'var(--text-primary)' }}>$340.00</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted-dim)', marginTop: 1, whiteSpace: 'nowrap' }}>850,000.000000 XTR</div>
              </div>
              <ChevronRight color="var(--text-muted-dim)" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 11px', opacity: 0.65 }}>
              <span style={{ width: 28, height: 28, borderRadius: 9, border: '1px dashed var(--border-strong)', color: 'var(--text-muted-dim)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Plus /></span>
              <span style={{ flex: 1, fontSize: 11.5, fontWeight: 500, color: 'var(--text-muted-dim)', textAlign: 'left' }}>More assets coming</span>
              <span style={{ padding: '2px 8px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border)', fontSize: 9, fontWeight: 600, color: 'var(--text-muted-dim)', flexShrink: 0 }}>Soon</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Sections ──────────────────────────────────────────────────────────────────

const STEPS = [
  { icon: <Browser />, title: 'Launch Caravel', body: 'Open the app in your browser. Nothing to install.' },
  { icon: <Wallet size={18} />, title: 'Create your wallet', body: 'Generated on your device. Your keys never leave it.' },
  { icon: <Key />, title: 'Save your recovery phrase', body: 'Your 24 words. The only way back in, held by you.' },
  { icon: <ArrowOut size={18} />, title: 'Start transacting', body: 'Send, receive, message, and claim your @name on the Ootle.' },
]

function HowItWorks() {
  return (
    <section id="how" className="cv-lp-section">
      <H2>How it works</H2>
      <div className="cv-lp-steps">
        {STEPS.map((s, i) => (
          <div key={s.title} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            <span style={{
              position: 'relative', width: 46, height: 46, borderRadius: 13,
              background: 'var(--lp-tile)', color: 'var(--lp-tile-ink)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              {s.icon}
              <span style={{
                position: 'absolute', top: -7, right: -7, width: 20, height: 20,
                borderRadius: 'var(--r-pill)', background: 'var(--accent-400)', color: '#FFFFFF',
                fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{i + 1}</span>
            </span>
            <h3 style={{ margin: '18px 0 0', fontSize: 16.5, fontWeight: 600, color: 'var(--text-primary)' }}>{s.title}</h3>
            <p style={{ margin: '7px 0 0', maxWidth: 220, fontSize: 14, lineHeight: 1.6, color: 'var(--text-body-dim)', textWrap: 'pretty' }}>{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

/** One service row: copy on one side, a navy demo card on the other. `flip` puts the card first. */
function ServiceRow({ title, body, card, flip = false }: {
  title: string; body: string; card: React.ReactNode; flip?: boolean
}) {
  const copy = (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{title}</h3>
        <Pill tone="live">Live</Pill>
      </div>
      <p style={{ margin: '14px 0 0', maxWidth: 400, fontSize: 16, lineHeight: 1.65, color: 'var(--text-body-dim)', textWrap: 'pretty' }}>{body}</p>
    </div>
  )
  // The card is ordered FIRST in the DOM when flipped so the visual alternation survives the
  // single-column breakpoint without a second set of rules — at narrow widths the reader gets
  // copy-then-card for rows 1 and 3, and card-then-copy for row 2, exactly as the design reads.
  return <div className="cv-lp-service">{flip ? <>{card}{copy}</> : <>{copy}{card}</>}</div>
}

const vaultCard = (extra: React.CSSProperties = {}): React.CSSProperties => ({
  background: 'var(--nav-ground)', border: '1px solid var(--border)', borderRadius: 18, ...extra,
})

function WalletCard() {
  return (
    <div style={vaultCard({ padding: 24 })}>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--vault-label)' }}>Total balance</div>
      <div style={{ ...VAULT_NUM, fontSize: 34, fontWeight: 700, letterSpacing: '-0.03em', marginTop: 6 }}>$340.00</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 16 }}>
        {(['shielded', 'unshielded'] as const).map((kind, i) => {
          const Icon = kind === 'shielded' ? Lock : Eye
          return (
            <div key={kind} style={{ background: 'var(--vault-card)', borderRadius: 'var(--r-md)', padding: '11px 13px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon size={11} color="var(--vault-label)" />
                <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--navy-200)' }}>{kind === 'shielded' ? 'Shielded' : 'Unshielded'}</span>
              </div>
              <div style={{ ...VAULT_NUM, fontSize: 15, marginTop: 5 }}>{i === 0 ? '$250.00' : '$90.00'}</div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
        <span style={{ flex: 1, textAlign: 'center', padding: '10px 6px', borderRadius: 9, fontSize: 12.5, fontWeight: 600, background: 'var(--accent-400)', color: '#FFFFFF' }}>Send</span>
        <span style={{ flex: 1, textAlign: 'center', padding: '10px 6px', borderRadius: 9, fontSize: 12.5, fontWeight: 600, background: 'var(--vault-card)', color: '#FFFFFF' }}>Receive</span>
      </div>
    </div>
  )
}

function ChatCard() {
  return (
    <div style={vaultCard({ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 })}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--vault-card)', color: 'var(--accent-300)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>@</span>
        <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#FFFFFF' }}>@okz61</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--vault-label)', marginTop: 1 }}>
            <Lock size={9} color="var(--vault-label)" />End-to-end encrypted
          </div>
        </div>
      </div>
      <div style={{ alignSelf: 'flex-start', maxWidth: '78%', background: 'var(--vault-card)', color: '#F2F6FA', borderRadius: '12px 12px 12px 4px', padding: '9px 13px', fontSize: 13, lineHeight: 1.5, textAlign: 'left' }}>
        Dinner was on me last time. Your turn.
      </div>
      <div style={{ alignSelf: 'flex-end', maxWidth: '78%', background: 'var(--accent-400)', color: '#FFFFFF', borderRadius: '12px 12px 4px 12px', padding: '9px 13px', fontSize: 13, lineHeight: 1.5, textAlign: 'left' }}>
        Fair. Sending it now, privately.
      </div>
      <div style={{ alignSelf: 'flex-end', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border-strong)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--vault-label)' }}>
        <Lock size={10} color="var(--vault-label)" />Shielded send to @okz61 · 33 XTR
      </div>
    </div>
  )
}

function NameCard() {
  return (
    <div style={vaultCard({ padding: 26, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 })}>
      <span style={{ width: 52, height: 52, borderRadius: 15, background: 'var(--vault-card)', color: 'var(--accent-300)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 600 }}>@</span>
      <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.015em', color: '#FFFFFF' }}>@okz61</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, letterSpacing: '0.05em', color: 'var(--vault-label)' }}>a3f9 20c4 8b1e 77d2</div>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 'var(--r-pill)', background: 'rgba(59,214,149,0.12)', color: '#3BD695', fontSize: 11.5, fontWeight: 600 }}>
        <span style={{ width: 5, height: 5, borderRadius: 'var(--r-pill)', background: '#3BD695' }} />Registered
      </span>
    </div>
  )
}

const SOON = [
  { icon: <Swap />, label: 'Swap' },
  { icon: <Bridge />, label: 'Bridge' },
  { icon: <Pools />, label: 'Pools' },
]

function Services() {
  return (
    <section className="cv-lp-section">
      <H2 narrow>One app. A growing set of private services.</H2>
      <ServiceRow
        title="Wallet"
        body="Shielded and unshielded balances in one place. Send, receive, and shield. Your money, your call."
        card={<WalletCard />}
      />
      <ServiceRow
        flip
        title="Chat"
        body="End-to-end encrypted messaging, tied to your wallet. Private money and private words, one conversation."
        card={<ChatCard />}
      />
      <ServiceRow
        title="Name"
        body="Claim your @name. One identity for payments and messages. Your money, your name."
        card={<NameCard />}
      />
      <div className="cv-lp-soon">
        {SOON.map(s => (
          <div key={s.label} style={{
            border: '1px dashed var(--border-strong)', borderRadius: 16, padding: '18px 24px',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ width: 34, height: 34, borderRadius: 'var(--r-md)', border: '1px solid var(--border)', color: 'var(--text-muted-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{s.icon}</span>
            <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: 'var(--text-body-dim)' }}>{s.label}</span>
            <Pill tone="quiet">Coming soon</Pill>
          </div>
        ))}
      </div>
    </section>
  )
}

function Backing() {
  const card = (extra: React.CSSProperties = {}): React.CSSProperties => ({
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18,
    padding: '44px 40px', boxShadow: 'var(--e1)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', ...extra,
  })
  const logo: React.CSSProperties = {
    width: 84, height: 84, borderRadius: 22, overflow: 'hidden', border: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  }
  const img: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' }
  return (
    <section className="cv-lp-section">
      <H2>Backing and ecosystem</H2>
      <div className="cv-lp-partners">
        <div style={card()}>
          {/* White plate behind the DNC mark — its artwork is drawn for a light ground. */}
          <span style={{ ...logo, background: '#FFFFFF' }}>
            <img src="/partner-dnc.png" alt="Digital Node Capital" style={img} />
          </span>
          <h3 style={{ margin: '24px 0 0', fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>Digital Node Capital</h3>
          <div style={{ marginTop: 10 }}><Pill tone="mono">BACKER</Pill></div>
          <p style={{ margin: '24px 0 0', maxWidth: 340, fontSize: 16.5, lineHeight: 1.6, fontWeight: 500, color: 'var(--text-primary)', textWrap: 'pretty' }}>
            &ldquo;We back builders making privacy usable. Caravel does exactly that.&rdquo;
          </p>
          <div style={{ marginTop: 14, fontSize: 13, fontWeight: 500, color: 'var(--text-muted-dim)' }}>DNC</div>
        </div>
        <div style={card()}>
          <span style={logo}><img src="/partner-tari.jpg" alt="Tari" style={img} /></span>
          <h3 style={{ margin: '24px 0 0', fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>Built on Tari</h3>
          <div style={{ marginTop: 10 }}><Pill tone="mono">PROTOCOL</Pill></div>
          <p style={{ margin: '24px 0 0', maxWidth: 340, fontSize: 15, lineHeight: 1.65, color: 'var(--text-body-dim)', textWrap: 'pretty' }}>
            Caravel runs on the Ootle, Tari&rsquo;s layer two for private, confidential transactions. Proven on chain.
          </p>
        </div>
      </div>
    </section>
  )
}

const FAQS: { q: string; a: string }[] = [
  { q: 'Is Caravel really self-custodial?', a: 'Yes. Your keys are generated on your device and never leave it. Not even Caravel can access your funds.' },
  { q: 'What if I lose my recovery phrase?', a: 'Your 24 words are the only way back in. Caravel cannot recover them for you, that is the nature of self-custody. Store them safely offline.' },
  { q: 'How is my activity kept private?', a: 'Balances can be shielded as confidential on the Ootle, and messages are end-to-end encrypted. You choose what stays visible.' },
  { q: 'Can I use real funds?', a: 'Not yet. Caravel runs on the Tari Esmeralda testnet. It is experimental and for testing, not for real value.' },
  { q: 'What are Tari and the Ootle?', a: 'Tari is the ecosystem Caravel is built on. The Ootle is its layer two for private, confidential transactions.' },
  { q: 'What is coming next?', a: 'Swap, Bridge, and Pools are on the way, expanding Caravel into the everything app for private crypto.' },
]

/**
 * The FAQ.
 *
 * ONE open at a time, and pressing the open one closes it — the design's `openFaq: -1`. Kept as an
 * index rather than a Set because that is the behaviour the design specifies; a multi-open
 * accordion is a different component and should not arrive by accident.
 */
function Faq() {
  const [open, setOpen] = useState(0)
  return (
    <section className="cv-lp-section">
      <H2>Frequently Asked Questions</H2>
      <div className="cv-lp-faq" style={{ borderTop: '1px solid var(--border)' }}>
        {FAQS.map((f, i) => {
          const isOpen = open === i
          return (
            <div key={f.q} style={{ borderBottom: '1px solid var(--border)' }}>
              <button
                onClick={() => setOpen(isOpen ? -1 : i)}
                aria-expanded={isOpen}
                style={{
                  cursor: 'pointer', width: '100%', background: 'transparent', border: 'none',
                  fontFamily: 'inherit', color: 'var(--text-primary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                  padding: '21px 4px', textAlign: 'left', fontSize: 16.5, fontWeight: 600,
                }}
              >
                <span>{f.q}</span>
                <Chevron color="var(--text-muted-dim)" dir={isOpen ? 'up' : 'down'} />
              </button>
              {isOpen && (
                <p style={{ margin: 0, padding: '0 4px 24px', maxWidth: 600, fontSize: 15, lineHeight: 1.65, color: 'var(--text-body-dim)', textWrap: 'pretty' }}>{f.a}</p>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── Scoped stylesheet ─────────────────────────────────────────────────────────
//
// Everything that has to CHANGE with viewport width lives here; colours and one-off offsets stay
// inline. `--lp-tile` / `--lp-tile-ink` are the design's step-tile wash, which is the one place the
// two themes tint DIFFERENT accent steps — 400 on light, 300 on dark, because a .12 wash of 400 on
// a navy ground barely reads.

const LANDING_CSS = `
.cv-lp {
  --lp-tile: rgba(var(--accent-400-rgb), 0.10);
  --lp-tile-ink: var(--accent-500);
  min-height: 100vh;
  background: var(--surface-void);
  color: var(--text-primary);
  font-family: var(--font-ui);
  transition: background 0.25s, color 0.25s;
}
.cv-lp[data-theme="dark"] {
  --lp-tile: rgba(var(--accent-300-rgb), 0.12);
  --lp-tile-ink: var(--accent-300);
}
.cv-lp a { color: var(--accent-600); text-decoration: none; }
.cv-lp[data-theme="dark"] a { color: var(--accent-300); }
.cv-lp a:hover { text-decoration: underline; }
.cv-lp ::selection { background: rgba(var(--accent-400-rgb), 0.22); }

.cv-lp-bar { max-width: 1120px; margin: 0 auto; padding: 22px 40px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.cv-lp-section { max-width: 1120px; margin: 0 auto; padding: 170px 40px 0; }
.cv-lp-hero { max-width: 1120px; margin: 0 auto; padding: 110px 40px 0; text-align: center; }

.cv-lp-h1 { margin: 0 auto; max-width: 840px; font-size: 60px; font-weight: 600;
  letter-spacing: -0.03em; line-height: 1.08; text-wrap: pretty; }
.cv-lp-h2 { font-size: 38px; }

.cv-lp-mock { max-width: 920px; margin: 90px auto 0; }
.cv-lp-steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 36px; margin-top: 64px; }
.cv-lp-service { display: grid; grid-template-columns: 1fr 1fr; gap: 72px; align-items: center;
  max-width: 980px; margin: 80px auto 0; }
.cv-lp-service ~ .cv-lp-service { margin-top: 96px; }
.cv-lp-soon { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px;
  max-width: 980px; margin: 96px auto 0; }
.cv-lp-partners { display: grid; grid-template-columns: 1fr 1fr; gap: 18px;
  max-width: 880px; margin: 56px auto 0; }
.cv-lp-faq { max-width: 680px; margin: 48px auto 0; }
.cv-lp-footer { max-width: 1120px; margin: 150px auto 0; padding: 34px 40px 44px;
  border-top: 1px solid var(--border); display: flex; align-items: center;
  justify-content: space-between; gap: 20px; flex-wrap: wrap; }

.cv-lp-primary { transition: background 0.15s; }
.cv-lp-primary:hover { background: var(--accent-hover) !important; }

/* ── ≤1024: the multi-column grids collapse; the rhythm tightens ── */
@media (max-width: 1024px) {
  .cv-lp-bar, .cv-lp-hero, .cv-lp-section, .cv-lp-footer { padding-left: 28px; padding-right: 28px; }
  .cv-lp-section { padding-top: 120px; }
  .cv-lp-hero { padding-top: 80px; }
  .cv-lp-h1 { font-size: 44px; }
  .cv-lp-h2 { font-size: 30px; }
  .cv-lp-mock { margin-top: 64px; }
  .cv-lp-steps { grid-template-columns: repeat(2, 1fr); gap: 40px 28px; margin-top: 48px; }
  .cv-lp-service { grid-template-columns: 1fr; gap: 32px; margin-top: 56px; }
  .cv-lp-service ~ .cv-lp-service { margin-top: 72px; }
  .cv-lp-soon { grid-template-columns: 1fr; margin-top: 72px; }
  .cv-lp-partners { grid-template-columns: 1fr; }
  .cv-lp-footer { margin-top: 110px; }
}

/* ── ≤880: the mockup's fixed 190px rail stops fitting beside a fluid pane ── */
@media (max-width: 880px) {
  .cv-lp-rail { display: none; }
}

/* ── ≤640: single column throughout, and the display sizes come down again ── */
@media (max-width: 640px) {
  .cv-lp-bar, .cv-lp-hero, .cv-lp-section, .cv-lp-footer { padding-left: 20px; padding-right: 20px; }
  .cv-lp-section { padding-top: 96px; }
  .cv-lp-h1 { font-size: 34px; }
  .cv-lp-h2 { font-size: 26px; }
  .cv-lp-steps { grid-template-columns: 1fr; gap: 36px; }
  .cv-lp-hero-ctas { flex-direction: column; gap: 16px !important; }
  .cv-lp-asset { flex-wrap: wrap; }
  .cv-lp-footer { justify-content: flex-start; }
}

@media (prefers-reduced-motion: reduce) {
  .cv-lp, .cv-lp-primary, .cv-icon-btn { transition: none; }
}
`

// ══════════════════════════════════════════════════════════════════════════════

export default function LandingPage() {
  const navigate = useNavigate()
  // The APP's theme, not a second copy of it. This page used to hold its own state over the same
  // storage key, and paint <body> by hand because the attribute was scoped to its own subtree. The
  // provider puts data-theme on <html>, so <body> is already correct and the choice a visitor makes
  // here is the one the gate screens and the wallet open in.
  const { theme } = useTheme()

  const onOpenApp = useCallback(() => navigate('/app'), [navigate])

  return (
    // The attribute stays for the scoped --lp-tile rules below; the value now comes from the app.
    <div className="cv-lp" data-theme={theme}>
      <style>{LANDING_CSS}</style>

      {/* Top bar */}
      <div className="cv-lp-bar">
        <Lockup tile={32} mark={17} text={18} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <ThemeToggle />
          <LaunchButton onClick={onOpenApp} />
        </div>
      </div>

      {/* Hero */}
      <section className="cv-lp-hero">
        <h1 className="cv-lp-h1">Caravel is a vessel for a new era of private exchange.</h1>
        <div style={{ margin: '26px auto 0', fontSize: 22, fontWeight: 500, color: 'var(--text-body-dim)' }}>
          A Swiss bank account in your pocket.
        </div>
        <div style={{ margin: '14px auto 0', maxWidth: 520, fontSize: 16, lineHeight: 1.6, color: 'var(--text-muted-dim)', textWrap: 'pretty' }}>
          Consolidate your day-to-day crypto operations, privately, in one place.
        </div>
        <div className="cv-lp-hero-ctas" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22, marginTop: 38 }}>
          <LaunchButton onClick={onOpenApp} big />
          <a href="#how" style={{ fontSize: 15, fontWeight: 500 }}>See how it works.</a>
        </div>
        <AppMockup />
      </section>

      <HowItWorks />
      <Services />
      <Backing />
      <Faq />

      {/* Closing CTA */}
      <section className="cv-lp-section" style={{ textAlign: 'center' }}>
        <H2>Ready to go private?</H2>
        <div style={{ marginTop: 32 }}><LaunchButton onClick={onOpenApp} big /></div>
      </section>

      {/* Footer */}
      <footer className="cv-lp-footer">
        <Lockup tile={26} mark={14} text={15} />
        <div style={{ display: 'flex', gap: 26, fontSize: 14 }}>
          {/* About and Docs have no destinations yet — deliberately inert rather than pointing
              somewhere wrong. The X link is real. */}
          <a href="#" style={{ color: 'var(--text-body-dim)' }}>About</a>
          <a href="#" style={{ color: 'var(--text-body-dim)' }}>Docs</a>
          <a href="https://x.com/Caravelxyz" target="_blank" rel="noreferrer noopener" style={{ color: 'var(--text-body-dim)' }}>X</a>
        </div>
        <div style={{ width: '100%', fontSize: 12.5, color: 'var(--text-muted-dim)', fontFamily: 'var(--font-mono)' }}>
          Running on the Tari Esmeralda testnet. Self-custodial and experimental. Don&rsquo;t use for real value.
        </div>
      </footer>
    </div>
  )
}
