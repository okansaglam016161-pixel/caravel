//   Landing page — public marketing page, reskinned to the "Caravel Landing Page (Build)" design
//   canvas (transcribed element-for-element from landingPreviewMarkup.ts). The four demo panels
//   (chat bubble, payment card, wallet panel, name result) are kept as transcribed design markup
//   (they already share the app's palette). Behaviour: CTAs → /app (preserved); nav scroll-links
//   and the donation Copy-address button are wired to match the design. Fixed 1440 layout per the
//   design canvas (a responsive pass is a tracked follow-up). Nav + footer marks use primitives/Logo
//   (mono variant); demo/decoration logos stay inline. Landing-specific keyframes + hover rules are
//   scoped under .cv-landing.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Logo from '../primitives/Logo'

const MONO = 'var(--font-mono)'

// Full donation address (copied); the on-screen value is the truncated form from the design.
const XTM_ADDR = '129Wf58tMXfYvqtQgQiuZbs8V75vGKKMPZGKSYVbQNvPDeHwaJ5VzjFXEhpsTEXs5NUbHm2JUVVum5Be1DKs1Zg9Sg7'
const XTM_ADDR_DISPLAY = '129Wf58tMXfYvqtQgQiuZbs8V75vGKK…um5Be1DKs1Zg9Sg7'

// Hero payment blips — the design's 6 SPOTS (positions + delays verbatim). Amounts are random in
// the design; representative sent/received values chosen here.
type Pos = { left?: number; right?: number; top?: number; bottom?: number }
const BLIPS: { pos: Pos; delay: number; dir: 'in' | 'out'; amount: string }[] = [
  { pos: { left: -158, top: 54 }, delay: 0.4, dir: 'in', amount: '42 tUSD' },
  { pos: { left: -132, top: 286 }, delay: 2.1, dir: 'out', amount: '128 tUSD' },
  { pos: { left: -166, bottom: 96 }, delay: 4.4, dir: 'in', amount: '7 tUSD' },
  { pos: { right: -150, top: 138 }, delay: 1.3, dir: 'out', amount: '63 tUSD' },
  { pos: { right: -128, bottom: 236 }, delay: 3.2, dir: 'in', amount: '205 tUSD' },
  { pos: { right: -162, bottom: 48 }, delay: 5.4, dir: 'out', amount: '19 tUSD' },
]

// Browser chrome bar (dots + centred URL pill), reused by all three demo frames.
function BrowserChrome({ url }: { url: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 18px', borderBottom: '1px solid rgba(var(--border-rgb),0.1)' }}>
      <div style={{ display: 'flex', gap: 7 }}>
        {[0, 1, 2].map(i => <span key={i} style={{ width: 11, height: 11, borderRadius: '50%', background: '#22293A' }} />)}
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 16px', borderRadius: 8, background: 'var(--surface-raised)', fontFamily: MONO, fontSize: 12, color: 'var(--text-faint)' }}>
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.4}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>{url}
        </span>
      </div>
      <div style={{ width: 40 }} />
    </div>
  )
}

// Small teal "eyebrow" pill used above section headings.
function Eyebrow({ icon, label, style }: { icon: React.ReactNode; label: string; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '6px 13px', borderRadius: 100, border: '1px solid rgba(var(--teal-500-rgb),0.3)', background: 'rgba(var(--teal-500-rgb),0.05)', ...style }}>
      {icon}
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--teal-300)', letterSpacing: '0.06em' }}>{label}</span>
    </div>
  )
}

export default function LandingPage() {
  const navigate = useNavigate()
  const onOpenApp = () => navigate('/app')
  const [copied, setCopied] = useState(false)

  function copyDonation() {
    navigator.clipboard.writeText(XTM_ADDR).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="cv-landing" style={{ background: 'var(--surface-void)', minHeight: '100vh', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', overflowX: 'auto' }}>
      <style>{`
        .cv-landing a { color: var(--teal-500); text-decoration: none; }
        .cv-landing a:hover { color: var(--accL, #5CEAD6); }
        .cv-landing .cv-primary:hover { filter: brightness(1.07); }
        .cv-landing .cv-quiet:hover { border-color: rgba(var(--border-rgb),0.34); color: var(--text-primary); }
        .cv-landing .cv-chip:hover { border-color: rgba(var(--teal-500-rgb),0.5); background: rgba(var(--teal-500-rgb),0.09); }
        .cv-landing .cv-nav-link:hover { color: var(--text-primary); }
        @keyframes cv-sweep { from { transform: translate(-50%, -50%) rotate(0deg); } to { transform: translate(-50%, -50%) rotate(360deg); } }
        @keyframes cv-blip {
          0% { opacity: 0; transform: scale(0.88); }
          6% { opacity: 1; transform: scale(1); }
          26% { opacity: 1; }
          44% { opacity: 0; transform: scale(0.96); }
          100% { opacity: 0; }
        }
        @keyframes cv-ping {
          0% { transform: translate(-50%, -50%) scale(0.42); opacity: 0; }
          12% { opacity: 0.55; }
          100% { transform: translate(-50%, -50%) scale(1.08); opacity: 0; }
        }
      `}</style>

      <div style={{ width: 1440, margin: '0 auto', background: 'var(--surface-void)', color: 'var(--text-primary)' }}>

        {/* sticky nav */}
        <div style={{ position: 'sticky', top: 0, zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 100px', background: 'rgba(5,8,14,0.88)', backdropFilter: 'blur(10px)', borderBottom: '1px solid rgba(var(--border-rgb),0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Logo size={36} mono />
            <span style={{ fontSize: 25, fontWeight: 700, letterSpacing: '-0.02em' }}>Caravel</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
            <a href="#how-it-works" className="cv-nav-link" style={{ fontSize: 18, color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '-0.01em', transition: '0.2s' }}>How it works</a>
            <a href="#private" className="cv-nav-link" style={{ fontSize: 18, color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '-0.01em', transition: '0.2s' }}>Privacy</a>
            <span onClick={onOpenApp} className="cv-primary" style={{ padding: '12px 24px', borderRadius: 11, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em', cursor: 'pointer', transition: '0.2s' }}>Launch Caravel</span>
          </div>
        </div>

        {/* hero */}
        <div style={{ position: 'relative', padding: '184px 100px 168px', display: 'flex', gap: 172, alignItems: 'center', overflow: 'hidden', borderBottom: '1px solid rgba(var(--border-rgb),0.1)' }}>
          <div style={{ flex: '0 0 560px' }}>
            <h1 style={{ margin: 0, fontSize: 58, lineHeight: 1.06, fontWeight: 900, letterSpacing: '-0.04em' }}>Private messages.<br />Private money.<br /><span style={{ color: 'var(--teal-500)' }}>One conversation.</span></h1>
            <p style={{ margin: '30px 0 0', maxWidth: 470, fontSize: 20, lineHeight: 1.6, color: 'var(--text-muted)' }}>Caravel is a vessel for a new era of private exchange.</p>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 40 }}>
              <span onClick={onOpenApp} className="cv-primary" style={{ display: 'inline-flex', alignItems: 'center', padding: '16px 32px', borderRadius: 12, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontSize: 18, fontWeight: 700, cursor: 'pointer', transition: '0.2s' }}>Launch Caravel</span>
              <span onClick={onOpenApp} className="cv-quiet" style={{ display: 'inline-flex', alignItems: 'center', padding: '16px 28px', borderRadius: 12, border: '1px solid rgba(var(--border-rgb),0.2)', color: 'var(--text-muted)', fontSize: 17, fontWeight: 600, cursor: 'pointer', transition: '0.2s' }}>Create wallet</span>
            </div>

            <div style={{ display: 'flex', flexWrap: 'nowrap', gap: 8, marginTop: 40 }}>
              {[
                { icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />, label: 'Nostr messaging' },
                { icon: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>, label: 'Ootle Enabled Payments' },
                { icon: <><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>, label: 'ONS on chain identity' },
              ].map(chip => (
                <span key={chip.label} className="cv-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 100, border: '1px solid rgba(var(--teal-500-rgb),0.3)', background: 'rgba(var(--teal-500-rgb),0.05)', whiteSpace: 'nowrap', transition: '0.2s' }}>
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">{chip.icon}</svg>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--teal-300)' }}>{chip.label}</span>
                </span>
              ))}
            </div>
          </div>

          {/* HERO DEMO */}
          <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 560, height: 560, borderRadius: '50%', border: '1px solid rgba(var(--teal-500-rgb),0.09)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 720, height: 720, borderRadius: '50%', border: '1px solid rgba(var(--teal-500-rgb),0.06)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 880, height: 880, borderRadius: '50%', border: '1px solid rgba(var(--teal-500-rgb),0.04)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: '50%', left: '50%', width: 880, height: 880, borderRadius: '50%', background: 'conic-gradient(from 0deg, rgba(45,224,198,0.20), rgba(45,224,198,0.06) 14%, rgba(45,224,198,0) 30%, rgba(45,224,198,0) 100%)', WebkitMaskImage: 'radial-gradient(circle, rgba(0,0,0,0) 26%, #000 52%, rgba(0,0,0,0) 82%)', maskImage: 'radial-gradient(circle, rgba(0,0,0,0) 26%, #000 52%, rgba(0,0,0,0) 82%)', animation: 'cv-sweep 7s linear infinite', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: '50%', left: '50%', width: 880, height: 880, borderRadius: '50%', border: '1px solid rgba(var(--teal-500-rgb),0.28)', animation: 'cv-ping 7s ease-out infinite', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: '50%', left: '50%', width: 880, height: 880, borderRadius: '50%', border: '1px solid rgba(var(--teal-500-rgb),0.22)', animation: 'cv-ping 7s ease-out infinite', animationDelay: '2.3s', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: '50%', left: '50%', width: 880, height: 880, borderRadius: '50%', border: '1px solid rgba(var(--teal-500-rgb),0.16)', animation: 'cv-ping 7s ease-out infinite', animationDelay: '4.6s', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 520, height: 520, borderRadius: '50%', background: 'radial-gradient(circle, rgba(45,224,198,0.09), rgba(45,224,198,0) 68%)', pointerEvents: 'none' }} />

            <div style={{ position: 'relative', width: 368 }}>
              {/* payment blips */}
              {BLIPS.map((b, i) => {
                const tint = b.dir === 'out' ? '255,122,136' : '45,224,198'
                const hue = b.dir === 'out' ? '#FF7A88' : '#2DE0C6'
                const amountColor = b.dir === 'out' ? '#FFB0B8' : '#8FE9DA'
                const iconPath = b.dir === 'out' ? 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z' : 'M12 3v12M7 11l5 5 5-5M4 21h16'
                return (
                  <div key={i} style={{ position: 'absolute', zIndex: 2, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px 6px 7px', borderRadius: 100, background: 'rgba(8,14,20,0.9)', border: `1px solid rgba(${tint},0.24)`, whiteSpace: 'nowrap', opacity: 0, pointerEvents: 'none', animation: 'cv-blip 7s ease-in-out infinite', animationDelay: `${b.delay}s`, ...b.pos }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 8, background: `rgba(${tint},0.12)`, border: `1px solid rgba(${tint},0.4)`, flexShrink: 0 }}>
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={hue} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={iconPath} /></svg>
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 12, letterSpacing: '0.03em', color: amountColor }}>{b.amount}</span>
                  </div>
                )
              })}

              {/* floating chips + connectors */}
              <div style={{ position: 'absolute', top: 86, left: -96, zIndex: 3, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 100, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.3)', boxShadow: '0 8px 22px rgba(0,0,0,0.45)' }}>
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>Chats</span>
              </div>
              <svg width={88} height={52} viewBox="0 0 88 52" style={{ position: 'absolute', top: 110, left: -14, zIndex: 2, pointerEvents: 'none' }} aria-hidden="true">
                <path d="M2 2 C 32 8 56 26 84 46" fill="none" stroke="rgba(45,224,198,0.35)" strokeWidth={1.5} strokeDasharray="3 5" />
                <circle cx="84" cy="46" r="3" fill="#2DE0C6" />
              </svg>
              <div style={{ position: 'absolute', bottom: 156, right: -102, zIndex: 3, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 100, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.3)', boxShadow: '0 8px 22px rgba(0,0,0,0.45)' }}>
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>Wallet</span>
              </div>
              <svg width={90} height={54} viewBox="0 0 90 54" style={{ position: 'absolute', bottom: 178, right: -16, zIndex: 2, pointerEvents: 'none' }} aria-hidden="true">
                <path d="M88 50 C 58 44 32 26 4 6" fill="none" stroke="rgba(45,224,198,0.35)" strokeWidth={1.5} strokeDasharray="3 5" />
                <circle cx="4" cy="6" r="3" fill="#2DE0C6" />
              </svg>

              {/* browser-framed chat demo */}
              <div style={{ position: 'relative', zIndex: 1, borderRadius: 16, border: '1px solid rgba(var(--border-rgb),0.14)', background: 'var(--surface)', boxShadow: '0 30px 80px rgba(0,0,0,0.55)', overflow: 'hidden' }}>
                <BrowserChrome url="caravel.app" />
                <div style={{ height: 580, background: 'var(--surface-base)', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 26px', borderBottom: '1px solid rgba(var(--border-rgb),0.08)' }}>
                    <div style={{ width: 38, height: 38, borderRadius: 11, background: 'linear-gradient(135deg, #1E6E63, #12A594)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: 'var(--text-bright)' }}>KJ</div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>Kinkajou</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.4}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                        <span style={{ fontSize: 12, color: 'var(--teal-300)', fontWeight: 500 }}>End to end encrypted</span>
                      </div>
                    </div>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '26px 30px', display: 'flex', flexDirection: 'column', gap: 14, justifyContent: 'flex-end' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                      <div style={{ maxWidth: 340, padding: '12px 16px', borderRadius: '4px 15px 15px 15px', background: 'var(--surface-inset)', fontSize: 15, lineHeight: 1.5, color: 'var(--text-body)' }}>Dinner was lovely. Your half came to 42.50 if you want to settle up.</div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <div style={{ maxWidth: 340, padding: '12px 16px', borderRadius: '15px 4px 15px 15px', background: 'linear-gradient(160deg, #1C7A6E, #12655A)', fontSize: 15, lineHeight: 1.5, color: 'var(--text-bright)' }}>Sending it now.</div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <div style={{ width: 300 }}>
                        <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(var(--teal-500-rgb),0.4)', background: 'linear-gradient(165deg, #0E2A28, #0A1A1C)', boxShadow: '0 0 30px rgba(45,224,198,0.14)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 15px', background: 'linear-gradient(180deg, rgba(45,224,198,0.14), rgba(45,224,198,0.04))', borderBottom: '1px solid rgba(var(--teal-500-rgb),0.2)' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--teal-300)', letterSpacing: '0.08em' }}>CONFIDENTIAL PAYMENT</span>
                            <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--teal-500)' }}>sent</span>
                          </div>
                          <div style={{ padding: '18px 15px 6px', textAlign: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 7 }}>
                              <span style={{ fontSize: 30, fontWeight: 800, color: 'var(--text-bright)' }}>42.50</span>
                              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--teal-500)' }}>TARI</span>
                            </div>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '4px 11px', borderRadius: 100, background: 'rgba(var(--border-rgb),0.08)', fontFamily: MONO, fontSize: 11, color: 'var(--text-teal-label)' }}>amount hidden</span>
                          </div>
                          <div style={{ margin: '11px 13px 14px', padding: '12px 14px', borderRadius: 11, background: 'rgba(10,14,23,0.6)', border: '1px dashed rgba(var(--teal-500-rgb),0.26)' }}>
                            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--text-teal-dim)', marginBottom: 6 }}>PRIVATE NOTE</div>
                            <div style={{ fontSize: 13, color: 'var(--text-note)', fontStyle: 'italic', lineHeight: 1.45 }}>&ldquo;My half of dinner. Next one is on me.&rdquo;</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '16px 26px 20px', borderTop: '1px solid rgba(var(--border-rgb),0.08)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 42, height: 42, borderRadius: 12, background: 'var(--teal-grad)', flexShrink: 0 }}>
                      <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                    </div>
                    <div style={{ flex: 1, padding: '12px 16px', borderRadius: 12, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)', fontSize: 14, color: 'var(--text-faint-dim)' }}>Write an encrypted message</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* how it works */}
        <div id="how-it-works" style={{ padding: '150px 100px 0', scrollMarginTop: 90 }}>
          <Eyebrow style={{ marginBottom: 44 }} label="HOW IT WORKS" icon={<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></svg>} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 40 }}>
            {[
              { n: '01', h: 'Your keys, your device', p: 'Your wallet is created in your browser. The private keys never leave your device.' },
              { n: '02', h: 'Message privately', p: 'Every message is end to end encrypted. Only you and the person you’re talking to can read it.' },
              { n: '03', h: 'Send confidential payments', p: 'Attach a payment to any message. The amount is hidden on chain, and only your recipient sees the note.' },
            ].map(card => (
              <div key={card.n} style={{ paddingTop: 24, borderTop: '1px solid rgba(var(--border-rgb),0.16)' }}>
                <div style={{ fontFamily: MONO, fontSize: 13, color: 'var(--teal-500)', marginBottom: 16 }}>{card.n}</div>
                <h3 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 700, letterSpacing: '-0.015em' }}>{card.h}</h3>
                <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: 'var(--text-muted-dim)' }}>{card.p}</p>
              </div>
            ))}
          </div>
        </div>

        {/* your keys, your device */}
        <div style={{ padding: '150px 100px 0', display: 'flex', gap: 72, alignItems: 'center' }}>
          <div style={{ flex: '0 0 380px' }}>
            <Eyebrow style={{ marginBottom: 22 }} label="SELF CUSTODY" icon={<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2L20 3M17 3h3v3" /></svg>} />
            <h2 style={{ margin: '0 0 20px', fontSize: 44, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.08 }}>Your keys,<br />your device.</h2>
            <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6, color: 'var(--text-muted)' }}>Caravel generates your wallet in the browser. The keys stay there. We hold nothing, and can&rsquo;t recover it for you. That&rsquo;s why your recovery phrase matters.</p>
          </div>
          <div style={{ flex: 1, borderRadius: 16, border: '1px solid rgba(var(--border-rgb),0.14)', background: 'var(--surface)', overflow: 'hidden' }}>
            <BrowserChrome url="caravel.app/wallet" />
            <div style={{ height: 420, boxSizing: 'border-box', background: 'var(--surface-base)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
              {/* wallet-panel demo (transcribed) */}
              <div style={{ width: 384, borderRadius: 18, background: 'var(--surface)', border: '1px solid rgba(var(--border-rgb),0.2)', boxShadow: '0 24px 60px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid rgba(var(--border-rgb),0.1)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Logo size={22} mono />
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Wallet</span>
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)' }} /><span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--warn-300)' }}>Esmeralda</span></span>
                </div>
                <div style={{ padding: '22px 18px 20px' }}>
                  <div style={{ borderRadius: 15, background: 'radial-gradient(300px 160px at 50% 0%, rgba(45,224,198,0.13), rgba(10,14,23,0))', border: '1px solid rgba(var(--teal-500-rgb),0.2)', padding: '22px 18px', textAlign: 'center', marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.14em', color: 'var(--text-teal-dim)', marginBottom: 10 }}>CONFIDENTIAL BALANCE</div>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 9 }}>
                      <span style={{ fontFamily: MONO, fontSize: 34, fontWeight: 700, color: 'var(--text-bright)' }}>••••••</span>
                      <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--teal-500)' }}>TARI</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--border-rgb),0.12)', marginBottom: 16 }}>
                    <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-body-dim)' }}>otl_esm_7f3a&hellip;9k2d</span>
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 13, borderRadius: 12, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>Send
                    </div>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 13, borderRadius: 12, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.26)', color: 'var(--text-bright)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7" /></svg>Receive
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* find anyone by name (ONS) */}
        <div style={{ padding: '150px 100px 0', display: 'flex', gap: 72, alignItems: 'center' }}>
          <div style={{ flex: '0 0 380px' }}>
            <Eyebrow style={{ marginBottom: 22 }} label="ONS IDENTITY" icon={<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></svg>} />
            <h2 style={{ margin: '0 0 20px', fontSize: 44, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.08 }}>Find anyone by name.</h2>
            <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6, color: 'var(--text-muted)' }}>Register an @name on chain. No central directory, no company holding the list. Someone types @okz61, and Caravel resolves it to their messaging key. Never to a payment address.</p>
          </div>
          <div style={{ flex: 1, borderRadius: 16, border: '1px solid rgba(var(--border-rgb),0.14)', background: 'var(--surface)', overflow: 'hidden' }}>
            <BrowserChrome url="caravel.app/new" />
            <div style={{ height: 420, boxSizing: 'border-box', background: 'var(--surface-base)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
              <div style={{ width: 420 }}>
                <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginBottom: 10 }}>New conversation</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 17px', borderRadius: 13, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.35)', marginBottom: 14 }}>
                  <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="var(--text-faint-dim)" strokeWidth={2} strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
                  <span style={{ fontFamily: MONO, fontSize: 16, color: 'var(--text-bright)' }}>@okz61</span>
                  <span style={{ width: 2, height: 18, background: 'var(--teal-500)' }} />
                </div>
                {/* name-result demo (transcribed) */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '15px 16px', borderRadius: 13, background: 'rgba(var(--teal-500-rgb),0.05)', border: '1px solid rgba(var(--teal-500-rgb),0.22)' }}>
                    <div style={{ width: 42, height: 42, borderRadius: 12, background: 'linear-gradient(135deg, #1E6E63, #12A594)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: 'var(--text-bright)', flexShrink: 0 }}>OK</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>@okz61</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 100, background: 'rgba(var(--teal-500-rgb),0.12)', fontSize: 10, fontWeight: 600, color: 'var(--teal-500)', letterSpacing: '0.06em' }}>RESOLVED ON CHAIN</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4 }}>
                        <span style={{ fontSize: 11, color: 'var(--text-teal-dim)' }}>npub</span>
                        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-faint)' }}>npub1f80&hellip;knttt</span>
                      </div>
                    </div>
                    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 6L9 17l-5-5" /></svg>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* private by default */}
        <div id="private" style={{ padding: '150px 100px 0', scrollMarginTop: 90 }}>
          <div style={{ position: 'relative', borderRadius: 22, background: 'radial-gradient(780px 340px at 50% 0%, rgba(45,224,198,0.13), #05080E 72%)', border: '1px solid rgba(var(--teal-500-rgb),0.16)', padding: '66px 60px 64px', textAlign: 'center', overflow: 'hidden' }}>
            <Eyebrow style={{ marginBottom: 26, background: 'transparent' }} label="WHAT CARAVEL PROTECTS" icon={<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>} />
            <h2 style={{ margin: '0 0 48px', fontSize: 60, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.04 }}>Private by default.</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0, borderTop: '1px solid rgba(var(--border-rgb),0.14)', paddingTop: 36 }}>
              {[
                { icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />, text: 'Message contents, encrypted end to end', border: false },
                { icon: <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />, text: 'Payment amounts on chain', border: true },
                { icon: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>, text: 'Private notes attached to payments', border: true },
              ].map((col, i) => (
                <div key={i} style={{ padding: '0 28px', borderLeft: col.border ? '1px solid rgba(var(--border-rgb),0.14)' : undefined }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, margin: '0 auto 16px', borderRadius: 10, background: 'rgba(var(--teal-500-rgb),0.1)', border: '1px solid rgba(var(--teal-500-rgb),0.28)' }}>
                    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{col.icon}</svg>
                  </div>
                  <div style={{ fontSize: 17, lineHeight: 1.5, color: 'var(--text-body)', fontWeight: 500 }}>{col.text}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* keep it sailing (donations) */}
        <div style={{ padding: '150px 100px 0' }}>
          <div style={{ position: 'relative', display: 'flex', gap: 64, alignItems: 'center', borderRadius: 22, border: '1px solid rgba(var(--teal-500-rgb),0.22)', background: 'linear-gradient(160deg, #0C1A1B, #070C12 68%)', boxShadow: '0 0 70px rgba(45,224,198,0.07)', padding: '56px 60px', overflow: 'hidden' }}>
            <svg viewBox="0 0 44 44" width={420} height={420} style={{ position: 'absolute', right: -40, bottom: -120, opacity: 0.05, pointerEvents: 'none' }} aria-hidden="true">
              <path d="M22 4 C 33 12 35 24 33 33 L 22 33 Z" fill="#2DE0C6" />
              <path d="M22 4 L 22 33 L 11 33 C 12 22 15 12 22 4 Z" fill="#2DE0C6" opacity={0.5} />
              <path d="M8 37 L 36 37 L 32 42 L 12 42 Z" fill="#2DE0C6" />
            </svg>
            <div style={{ position: 'relative', flex: 1 }}>
              <Eyebrow style={{ marginBottom: 22 }} label="FUND THE VOYAGE" icon={
                <svg viewBox="0 0 44 44" width={13} height={13} aria-hidden="true">
                  <path d="M22 4 C 33 12 35 24 33 33 L 22 33 Z" fill="#2DE0C6" />
                  <path d="M22 4 L 22 33 L 11 33 C 12 22 15 12 22 4 Z" fill="#2DE0C6" opacity={0.45} />
                  <path d="M8 37 L 36 37 L 32 42 L 12 42 Z" fill="#2DE0C6" />
                </svg>
              } />
              <h2 style={{ margin: '0 0 18px', fontSize: 48, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.05 }}>Keep it sailing.</h2>
              <p style={{ margin: 0, maxWidth: 420, fontSize: 17, lineHeight: 1.6, color: 'var(--text-muted)' }}>Caravel is free. It runs on donations, not ads or your data. If it&rsquo;s useful to you, help keep it sailing.</p>
            </div>
            <div style={{ position: 'relative', flex: '0 0 400px', padding: 24, borderRadius: 18, background: 'rgba(6,10,16,0.72)', border: '1px solid rgba(var(--teal-500-rgb),0.26)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16 }}>
                <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--teal-300)' }}>DONATE XTM</span>
              </div>
              <div style={{ padding: '14px 16px', borderRadius: 12, background: 'var(--surface-base)', border: '1px solid rgba(var(--border-rgb),0.14)', fontFamily: MONO, fontSize: 13, whiteSpace: 'nowrap', color: 'var(--text-body-dim)', marginBottom: 14 }}>{XTM_ADDR_DISPLAY}</div>
              <div onClick={copyDonation} className="cv-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 14, borderRadius: 12, background: 'var(--teal-grad)', color: 'var(--ink-on-accent)', fontSize: 15, fontWeight: 700, cursor: 'pointer', transition: '0.2s' }}>
                <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--ink-on-accent)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg><span>{copied ? 'Address copied' : 'Copy address'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '60px 100px 56px', marginTop: 90, borderTop: '1px solid rgba(var(--border-rgb),0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Logo size={22} mono />
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-body-dim)' }}>Caravel</span>
            <span style={{ color: '#2C3648' }}>&middot;</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--text-faint)' }}>Backed by
              <svg viewBox="0 0 400 400" width={17} height={17} style={{ opacity: 0.8 }}>
                <g fill="none" stroke="#0A84FF" strokeWidth={22} strokeLinecap="round">
                  <path d="M 289.8 109.2 A 253.3 253.3 0 0 0 98.4 105.2" />
                  <path d="M 326.9 171.8 A 216.0 216.0 0 0 0 60.2 165.2" />
                  <path d="M 323.1 215.2 A 181.5 181.5 0 0 0 61.9 208.6" />
                  <path d="M 299.2 239.2 A 147.4 147.4 0 0 0 96.4 223.4" />
                  <path d="M 296.5 302.9 A 112.1 112.1 0 0 0 139.6 235.8" />
                  <path d="M 266.7 325.1 A 78.0 78.0 0 0 0 189.4 257.9" />
                </g>
              </svg>
              <span style={{ color: '#0A84FF', fontWeight: 600, letterSpacing: '0.04em' }}>DNC</span>
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: 12, color: 'var(--text-faint)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)' }} />Testnet
            </span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-faint-dim)' }}>&copy; 2026 Caravel</span>
          </div>
        </div>

      </div>
    </div>
  )
}
