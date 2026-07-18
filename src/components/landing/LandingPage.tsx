import { useNavigate } from 'react-router-dom'
import Logo from '../Logo'

export default function LandingPage() {
  const navigate = useNavigate()
  const onOpenApp = () => navigate('/app')
  return (
    <div style={{ minHeight: '100vh', background: '#0A0E17' }}>
      <div>

        {/* Nav */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 44px', borderBottom: '1px solid rgba(120,150,210,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <Logo size={30} />
            <span style={{ fontSize: 21, fontWeight: 700, color: '#F2F5FB', letterSpacing: '0.01em' }}>Caravel</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 30 }}>
            <span style={{ fontSize: 15, color: '#8A97B4', fontWeight: 500, cursor: 'pointer' }}>How it works</span>
            <span style={{ fontSize: 15, color: '#8A97B4', fontWeight: 500, cursor: 'pointer' }}>Privacy</span>
            <span className="cv-btn-primary" onClick={onOpenApp} style={{ display: 'inline-flex', alignItems: 'center', padding: '11px 24px', borderRadius: 10, background: 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))', color: 'var(--accOn,#04120F)', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Open Caravel</span>
          </div>
        </div>

        {/* Hero */}
        <div style={{ position: 'relative', padding: '104px 64px 108px', overflow: 'hidden' }}>
          {/* glow */}
          <div style={{ position: 'absolute', top: '50%', right: -60, transform: 'translateY(-50%)', width: 680, height: 680, borderRadius: '50%', background: 'radial-gradient(circle, rgba(var(--accRGB,45,224,198),0.16), rgba(var(--accRGB,45,224,198),0) 64%)', pointerEvents: 'none' }} />
          {/* arcs */}
          <svg viewBox="0 0 400 400" width={460} height={460} style={{ position: 'absolute', top: '50%', right: 50, transform: 'translateY(-50%)', opacity: 0.08, pointerEvents: 'none' }}>
            <g fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={10} strokeLinecap="round">
              <path d="M 289.8 109.2 A 253.3 253.3 0 0 0 98.4 105.2" />
              <path d="M 313.9 141.5 A 232.5 232.5 0 0 0 52.2 150.2" />
              <path d="M 326.9 171.8 A 216.0 216.0 0 0 0 60.2 165.2" />
              <path d="M 331.3 199.3 A 197.6 197.6 0 0 0 52.7 194.3" />
              <path d="M 323.1 215.2 A 181.5 181.5 0 0 0 61.9 208.6" />
              <path d="M 311.3 227.3 A 164.4 164.4 0 0 0 67.5 227.5" />
              <path d="M 299.2 239.2 A 147.4 147.4 0 0 0 96.4 223.4" />
              <path d="M 303.3 275.0 A 129.7 129.7 0 0 0 103.6 239.4" />
              <path d="M 296.5 302.9 A 112.1 112.1 0 0 0 139.6 235.8" />
              <path d="M 281.9 313.3 A 95.2 95.2 0 0 0 151.4 249.1" />
              <path d="M 266.7 325.1 A 78.0 78.0 0 0 0 189.4 257.9" />
            </g>
          </svg>

          <div style={{ position: 'relative', maxWidth: 820 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 32 }}>
              <div style={{ width: 2, height: 38, background: 'linear-gradient(180deg, var(--acc,#2DE0C6), rgba(var(--accRGB,45,224,198),0))' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 500, color: 'var(--acc,#2DE0C6)', letterSpacing: '0.22em' }}>ENCRYPTED END TO END</span>
                <span style={{ fontSize: 14, color: '#8A97B4' }}>Built on the Tari network</span>
              </div>
            </div>
            <h1 style={{ margin: 0, fontSize: 68, lineHeight: 1.04, fontWeight: 800, letterSpacing: '-0.02em', color: '#F5F8FD', textWrap: 'balance' } as React.CSSProperties}>
              Private messages,<br />private money.<br />
              <span style={{ background: 'linear-gradient(90deg, var(--accL,#5CEAD6), var(--acc,#2DE0C6))', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>One conversation.</span>
            </h1>
            <p style={{ margin: '28px 0 0', fontSize: 20, lineHeight: 1.55, color: '#99A6C2', maxWidth: 620, fontWeight: 400 }}>Caravel is a vessel for a new era of private exchange. Chat end to end encrypted and send confidential payments, amounts hidden, without ever leaving the thread.</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 40 }}>
              <span className="cv-btn-primary" onClick={onOpenApp} style={{ display: 'inline-flex', alignItems: 'center', padding: '15px 32px', borderRadius: 12, background: 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))', color: 'var(--accOn,#04120F)', fontSize: 17, fontWeight: 700, cursor: 'pointer' }}>Open Caravel</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '15px 26px', borderRadius: 12, border: '1px solid rgba(120,150,210,0.24)', color: '#C7D0E4', fontSize: 17, fontWeight: 600, cursor: 'pointer' }}>How it works</span>
            </div>
          </div>
        </div>

        {/* How it works */}
        <div style={{ padding: '20px 64px 92px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 34 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: '0.22em', color: '#55617D' }}>HOW IT WORKS</h2>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: '#55617D' }}>three steps, keys stay with you</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            {/* Step 1 */}
            <div className="cv-step" style={{ padding: 30, borderRadius: 16, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)', transition: 'border-color 0.2s' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, borderRadius: 12, background: 'rgba(var(--accRGB,45,224,198),0.1)', border: '1px solid rgba(var(--accRGB,45,224,198),0.24)', marginBottom: 22 }}>
                <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><rect x={3} y={11} width={18} height={11} rx={2} /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: 'var(--acc,#2DE0C6)', marginBottom: 10 }}>01</div>
              <h3 style={{ margin: '0 0 10px', fontSize: 20, fontWeight: 700, color: '#EEF2FA' }}>Your keys, your device</h3>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: '#8A97B4' }}>Your wallet is created right in your browser. Private keys are generated on your device and never leave it, not to us, not to anyone.</p>
            </div>
            {/* Step 2 */}
            <div className="cv-step" style={{ padding: 30, borderRadius: 16, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)', transition: 'border-color 0.2s' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, borderRadius: 12, background: 'rgba(var(--accRGB,45,224,198),0.1)', border: '1px solid rgba(var(--accRGB,45,224,198),0.24)', marginBottom: 22 }}>
                <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: 'var(--acc,#2DE0C6)', marginBottom: 10 }}>02</div>
              <h3 style={{ margin: '0 0 10px', fontSize: 20, fontWeight: 700, color: '#EEF2FA' }}>Message privately</h3>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: '#8A97B4' }}>Every message is end to end encrypted. Only you and the person you're talking to can read what's said. The network carries it blind.</p>
            </div>
            {/* Step 3 */}
            <div className="cv-step" style={{ padding: 30, borderRadius: 16, background: '#10151F', border: '1px solid rgba(120,150,210,0.14)', transition: 'border-color 0.2s' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, borderRadius: 12, background: 'rgba(var(--accRGB,45,224,198),0.1)', border: '1px solid rgba(var(--accRGB,45,224,198),0.24)', marginBottom: 22 }}>
                <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: 'var(--acc,#2DE0C6)', marginBottom: 10 }}>03</div>
              <h3 style={{ margin: '0 0 10px', fontSize: 20, fontWeight: 700, color: '#EEF2FA' }}>Send confidential payments</h3>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: '#8A97B4' }}>Attach a payment to any message. The amount is hidden on-chain, with a private note only your recipient can see. Money and message, one send.</p>
            </div>
          </div>
        </div>

        {/* Privacy: honest */}
        <div style={{ padding: '0 64px 92px' }}>
          <div style={{ borderRadius: 18, background: 'linear-gradient(150deg, #0C1A1B, #0A0E17 62%)', border: '1px solid rgba(var(--accRGB,45,224,198),0.16)', padding: '48px 52px' }}>
            <div style={{ display: 'flex', gap: 56, alignItems: 'flex-start' }}>
              <div style={{ flex: '0 0 300px' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '6px 13px', borderRadius: 100, border: '1px solid rgba(var(--accRGB,45,224,198),0.3)', marginBottom: 20 }}>
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accT,#7DE9D8)', letterSpacing: '0.04em' }}>HONEST PRIVACY</span>
                </div>
                <h2 style={{ margin: 0, fontSize: 38, fontWeight: 800, letterSpacing: '-0.02em', color: '#F2F5FB', lineHeight: 1.1 }}>Private,<br />not invisible.</h2>
                <p style={{ margin: '18px 0 0', fontSize: 15, lineHeight: 1.6, color: '#8A97B4' }}>We'd rather be trusted than oversell. Here's exactly what Caravel keeps hidden.</p>
              </div>
              <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ gridColumn: '1 / -1', padding: '22px 24px', borderRadius: 14, background: 'rgba(var(--accRGB,45,224,198),0.05)', border: '1px solid rgba(var(--accRGB,45,224,198),0.18)' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--acc,#2DE0C6)', marginBottom: 18 }}>WHAT CARAVEL HIDES</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div style={{ display: 'flex', gap: 11, fontSize: 16, color: '#C7D0E4' }}><span style={{ color: 'var(--acc,#2DE0C6)' }}>✓</span> Message contents, encrypted end to end</div>
                    <div style={{ display: 'flex', gap: 11, fontSize: 16, color: '#C7D0E4' }}><span style={{ color: 'var(--acc,#2DE0C6)' }}>✓</span> Payment amounts on chain</div>
                    <div style={{ display: 'flex', gap: 11, fontSize: 16, color: '#C7D0E4' }}><span style={{ color: 'var(--acc,#2DE0C6)' }}>✓</span> Private notes attached to payments</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '30px 64px', borderTop: '1px solid rgba(120,150,210,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <svg viewBox="0 0 400 400" width={26} height={26} style={{ opacity: 0.65 }}>
              <g fill="none" stroke="#4A6296" strokeWidth={18} strokeLinecap="round">
                <path d="M 289.8 109.2 A 253.3 253.3 0 0 0 98.4 105.2" />
                <path d="M 326.9 171.8 A 216.0 216.0 0 0 0 60.2 165.2" />
                <path d="M 323.1 215.2 A 181.5 181.5 0 0 0 61.9 208.6" />
                <path d="M 299.2 239.2 A 147.4 147.4 0 0 0 96.4 223.4" />
                <path d="M 296.5 302.9 A 112.1 112.1 0 0 0 139.6 235.8" />
                <path d="M 266.7 325.1 A 78.0 78.0 0 0 0 189.4 257.9" />
              </g>
            </svg>
            <span style={{ fontSize: 14, color: '#6B7793' }}>Incubated by <span style={{ color: '#0A84FF', fontWeight: 600, letterSpacing: '0.06em' }}>DNC</span></span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 13px', borderRadius: 100, border: '1px solid rgba(255,180,60,0.3)', background: 'rgba(255,180,60,0.06)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#FFB43C' }} />
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: '#FFC978', letterSpacing: '0.04em' }}>TESTNET</span>
            </span>
            <span style={{ fontSize: 13, color: '#55617D', fontFamily: "'IBM Plex Mono', monospace" }}>© 2026 Caravel</span>
          </div>
        </div>

      </div>
    </div>
  )
}
