// The public landing page, at `/`. Built to the approved design (Claude Design mockup Main.dc.html):
// a split hero with a live-looking chat, a three-step strip, the backers, a Q&A drawn as a chat with
// Caravel, a closing call to action and a minimal footer.
//
// THEME. Everything resolves through the app's role tokens (index.css), so the page follows the real
// theme (hooks/useTheme + ThemeToggle) in both directions. The few colours the app has no role token
// for are scoped `--lp-*` variables on `.cv-lp`, set once per theme in LANDING_CSS below.
//
// LAYOUT. Rows are flex-wrap with flex-basis, as in the design, so columns stack on their own when
// the window narrows; the media queries only tighten the outer padding and the vertical rhythm.

import { useCallback, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../../hooks/useTheme'
import ThemeToggle from '../primitives/ThemeToggle'
import LogoTile from '../primitives/LogoTile'
import ChatStill, { Bubble, CaravelAvatar, StillBody, StillHeader, StillWindow } from './ChatStill'

const MONO = 'var(--font-mono)'
const DOCS_URL = 'https://github.com/okansaglam016161-pixel/caravel#readme'
const X_URL = 'https://x.com/Caravelxyz'

// ── Content ───────────────────────────────────────────────────────────────────

const STEPS = [
  { n: '01', title: 'Create your Nostr identity.', body: 'Made on your device, or import your nsec.' },
  { n: '02', title: 'Connect Sapient.', body: 'Your wallet for TARI on the Ootle.' },
  { n: '03', title: 'Message any npub.', body: 'Pay in the chat, amounts hidden on chain.' },
]

const FAQS = [
  { q: 'What do I need?', a: 'A desktop browser (Chrome, Brave or Edge). For payments, the Sapient wallet extension.' },
  { q: 'How do people find me?', a: 'Share your npub, your public Nostr ID. Anyone with it can message you and pay you.' },
  { q: 'Who holds my funds?', a: 'You do. Your funds and wallet keys stay in Sapient on your computer. Caravel never sees them.' },
  { q: 'What if I lose my backup phrase?', a: 'Your 12 words (or nsec) are the only way to restore your chat identity. Nobody can recover them for you, including us.' },
  { q: 'Can I use real funds?', a: 'Yes. Caravel runs on Ootle mainnet.' },
]

// ── Pieces ────────────────────────────────────────────────────────────────────

function Lockup({ tile, text, gap }: { tile: number; text: number; gap: number }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap }}>
      <LogoTile size={tile} />
      <span style={{ fontSize: text, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>Caravel</span>
    </span>
  )
}

/** "Launch Caravel". `big` is the hero and closing size. Every one goes to /app. */
function LaunchButton({ onClick, big = false, mt }: { onClick: () => void; big?: boolean; mt?: number }) {
  return (
    <button
      type="button" onClick={onClick} className="cv-lp-primary"
      style={{
        cursor: 'pointer', fontFamily: 'inherit', border: 'none', borderRadius: 10,
        background: 'var(--accent-400)', color: '#FFFFFF', fontWeight: 600,
        display: 'inline-flex', alignItems: 'center',
        ...(big
          ? { fontSize: 16, padding: '15px 30px', boxShadow: 'var(--e2)' }
          : { fontSize: 14, padding: '10px 18px' }),
        ...(mt !== undefined ? { marginTop: mt } : {}),
      }}
    >Launch Caravel</button>
  )
}

/** The mono tag on a backer card. */
function Tag({ children }: { children: ReactNode }) {
  return (
    <span style={{
      display: 'inline-block', fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.14em',
      color: 'var(--text-body-dim)', border: '1px solid var(--border)', borderRadius: 999, padding: '5px 12px',
    }}>{children}</span>
  )
}

function BackerCard({ logo, tag, title, children }: { logo: ReactNode; tag: string; title: string; children: ReactNode }) {
  return (
    <div className="cv-lp-card" style={{
      flex: '1 1 320px', minWidth: 0, background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 18, padding: 32, boxShadow: 'var(--e1)',
      display: 'flex', gap: 22, alignItems: 'flex-start',
    }}>
      {logo}
      <div style={{ minWidth: 0 }}>
        <Tag>{tag}</Tag>
        <h3 style={{ margin: '14px 0 0', fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>{title}</h3>
        <p style={{ margin: '8px 0 0', fontSize: 16, lineHeight: 1.6, fontWeight: 500, color: 'var(--text-body-dim)' }}>{children}</p>
      </div>
    </div>
  )
}

/** A partner logo on its 72px plate. `plate` is the ground behind artwork drawn for a light page. */
function PartnerLogo({ src, alt, plate }: { src: string; alt: string; plate?: string }) {
  return (
    <span style={{
      flexShrink: 0, width: 72, height: 72, borderRadius: 20, overflow: 'hidden',
      border: '1px solid var(--border)', background: plate ?? 'var(--surface)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <img src={src} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const navigate = useNavigate()
  const { theme } = useTheme()
  const launch = useCallback(() => navigate('/app'), [navigate])

  return (
    <div className="cv-lp" data-theme={theme}>
      <style>{LANDING_CSS}</style>

      {/* ── Top bar ── */}
      <header className="cv-lp-wrap cv-lp-bar">
        <a href="#top" aria-label="Caravel, back to top" style={{ textDecoration: 'none' }}>
          <Lockup tile={32} text={18} gap={10} />
        </a>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <ThemeToggle />
          <LaunchButton onClick={launch} />
        </div>
      </header>

      {/* ── Hero: copy left, the chat window right; stacks when narrow ── */}
      <section id="top" className="cv-lp-wrap cv-lp-hero">
        <div style={{ flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          <h1 className="cv-lp-h1">The vessel for a new era of private exchange.</h1>
          <p style={{ margin: '24px 0 0', maxWidth: 460, fontSize: 20, lineHeight: 1.5, fontWeight: 500, color: 'var(--text-body-dim)' }}>
            Private messages and private payments, in one conversation.
          </p>
          <LaunchButton onClick={launch} big mt={36} />
          <p style={{ margin: '16px 0 0', fontSize: 14, color: 'var(--text-body-dim)' }}>
            Free and self-custodial. Desktop Chrome, Brave or Edge.
          </p>
        </div>
        <div style={{ flex: '1 1 460px', minWidth: 0 }}>
          <ChatStill />
        </div>
      </section>

      {/* ── Steps strip ── */}
      <section className="cv-lp-wrap cv-lp-steps">
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 28, display: 'flex', flexWrap: 'wrap', gap: '20px 40px' }}>
          {STEPS.map(s => (
            <div key={s.n} style={{ flex: '1 1 240px', display: 'flex', gap: 14, alignItems: 'baseline' }}>
              <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: 'var(--lp-tile-ink)' }}>{s.n}</span>
              <div>
                <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>{s.title}</span>{' '}
                <span style={{ fontSize: 15, color: 'var(--text-body-dim)' }}>{s.body}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Ecosystem: the backers. Heading styled like FAQs; 32px to the cards, the FAQs row gap. ── */}
      <section className="cv-lp-wrap cv-lp-section">
        <h2 className="cv-lp-h2">Ecosystem</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 32 }}>
          <BackerCard tag="BACKER" title="Digital Node Capital"
            logo={<PartnerLogo src="/partner-dnc.png" alt="Digital Node Capital" plate="#FFFFFF" />}>
            &ldquo;We back builders making privacy usable. Caravel does exactly that.&rdquo;
          </BackerCard>
          <BackerCard tag="PROTOCOL" title="Built on Tari"
            logo={<PartnerLogo src="/partner-tari.jpg" alt="Tari" />}>
            Caravel runs on the Ootle, Tari&rsquo;s programmable layer two for confidential assets.
          </BackerCard>
        </div>
      </section>

      {/* ── Questions: title left, a chat with Caravel right ── */}
      <section className="cv-lp-wrap cv-lp-section cv-lp-questions">
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <h2 className="cv-lp-h2">FAQs</h2>
          <p style={{ margin: '14px 0 0', maxWidth: 300, fontSize: 16, lineHeight: 1.6, color: 'var(--text-body-dim)' }}>
            The short answers. More in the docs.
          </p>
        </div>
        <StillWindow style={{ flex: '2 1 520px' }}>
          <StillHeader avatar={<CaravelAvatar />} name="Caravel" status="Frequently asked" />
          <StillBody padding="26px 22px 30px" gap={10}>
            {FAQS.map(f => (
              <div key={f.q} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 10 }}>
                <Bubble side="out" maxWidth="75%" weight={500}>{f.q}</Bubble>
                <Bubble side="in" maxWidth="80%" lineHeight={1.55}>{f.a}</Bubble>
              </div>
            ))}
          </StillBody>
        </StillWindow>
      </section>

      {/* ── Closing ── */}
      <section className="cv-lp-wrap cv-lp-section cv-lp-closing">
        <h2 className="cv-lp-h2-close">Ready to go private?</h2>
        <p style={{ margin: '18px 0 0', fontSize: 18, lineHeight: 1.5, color: 'var(--text-body-dim)' }}>
          Open Caravel in your browser and create your identity.
        </p>
        <LaunchButton onClick={launch} big mt={32} />
      </section>

      {/* ── Footer ── */}
      <footer className="cv-lp-footer">
        <div className="cv-lp-wrap cv-lp-footer-row">
          <Lockup tile={26} text={15} gap={9} />
          <nav style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <a href={X_URL} target="_blank" rel="noopener noreferrer" className="cv-lp-quiet">X</a>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="cv-lp-quiet">Docs</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
//
// Scoped to .cv-lp. Role tokens come from index.css; the `--lp-*` set covers the colours the app has
// no role for (the step-number ink, the Mira avatar, the RECEIVED green), per theme.

const LANDING_CSS = `
.cv-lp {
  --lp-tile-ink: var(--accent-500);
  --lp-avatar-bg: var(--accent-50);
  --lp-avatar-ink: var(--accent-600);
  --lp-green: #0E6E4C;
  min-height: 100vh;
  background: var(--surface-void);
  color: var(--text-primary);
  font-family: var(--font-ui);
  transition: background 0.2s, color 0.2s;
}
.cv-lp[data-theme="dark"] {
  --lp-tile-ink: var(--accent-300);
  --lp-avatar-bg: var(--accent-800);
  --lp-avatar-ink: var(--accent-200);
  --lp-green: var(--positive);
}
.cv-lp a { color: var(--accent-600); text-decoration: none; }
.cv-lp a:hover { color: var(--accent-700); }
.cv-lp[data-theme="dark"] a { color: var(--accent-300); }
.cv-lp[data-theme="dark"] a:hover { color: var(--accent-200); }
.cv-lp a.cv-lp-quiet { font-size: 14px; color: var(--text-body-dim); }
.cv-lp a.cv-lp-quiet:hover { color: var(--text-primary); }
.cv-lp ::selection { background: rgba(var(--accent-400-rgb), 0.22); }

.cv-lp-wrap { max-width: 1120px; margin: 0 auto; padding-left: 40px; padding-right: 40px; box-sizing: border-box; }
.cv-lp-bar { padding-top: 22px; padding-bottom: 22px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.cv-lp-hero { padding-top: 88px; display: flex; flex-wrap: wrap; align-items: center; gap: 56px; }
.cv-lp-steps { padding-top: 96px; }
.cv-lp-section { padding-top: 150px; }
.cv-lp-questions { display: flex; flex-wrap: wrap; gap: 32px 64px; align-items: flex-start; }
.cv-lp-closing { display: flex; flex-direction: column; align-items: center; text-align: center; }

.cv-lp-h1 { margin: 0; font-size: clamp(36px, 4.6vw, 58px); line-height: 1.06; font-weight: 600; letter-spacing: -0.03em; }
.cv-lp-h2 { margin: 0; font-size: clamp(26px, 3.2vw, 38px); line-height: 1.15; font-weight: 600; letter-spacing: -0.025em; }
.cv-lp-h2-close { margin: 0; font-size: clamp(30px, 4vw, 46px); line-height: 1.1; font-weight: 600; letter-spacing: -0.03em; }

.cv-lp-footer { margin-top: 150px; border-top: 1px solid var(--border); }
.cv-lp-footer-row { padding-top: 34px; padding-bottom: 44px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }

.cv-lp-primary { transition: background 0.15s; }
.cv-lp-primary:hover { background: var(--accent-hover) !important; }

@media (max-width: 640px) {
  .cv-lp-wrap { padding-left: 20px; padding-right: 20px; }
  .cv-lp-hero { padding-top: 56px; gap: 40px; }
  .cv-lp-steps { padding-top: 72px; }
  .cv-lp-section { padding-top: 96px; }
  .cv-lp-footer { margin-top: 96px; }
  .cv-lp-card { padding: 24px !important; gap: 18px !important; }
}
@media (max-width: 380px) {
  .cv-lp-card { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  .cv-lp, .cv-lp-primary { transition: none; }
}
`
