import { useState } from 'react'
import { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import { Network } from '@tari-project/ootle'

export default function SdkTest() {
  const [result, setResult] = useState<string>('not run')
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setResult('generating…')
    setError(null)
    try {
      const wallet = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
      const addr = await wallet.getAddress()
      setResult(addr)
      console.log('[SdkTest] owner address:', addr)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      console.error('[SdkTest] error:', e)
    }
  }

  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      background: '#10151F', border: '1px solid rgba(45,224,198,0.3)',
      borderRadius: 12, padding: '16px 20px', maxWidth: 520,
      fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
    }}>
      <div style={{ color: '#7DE9D8', fontWeight: 700, marginBottom: 10, letterSpacing: '0.08em' }}>
        SDK TEST — THROWAWAY
      </div>
      <button onClick={run} style={{
        display: 'block', width: '100%', padding: '8px 0',
        background: 'linear-gradient(180deg, #34E5D0, #12A594)',
        color: '#04120F', fontFamily: 'inherit', fontSize: 12,
        fontWeight: 700, border: 'none', borderRadius: 8, cursor: 'pointer',
        marginBottom: 12, letterSpacing: '0.04em',
      }}>
        Generate Esmeralda wallet
      </button>
      {error ? (
        <div style={{ color: '#FF6B6B', wordBreak: 'break-all' }}>ERROR: {error}</div>
      ) : (
        <div style={{ color: result.startsWith('otl_') ? '#2DE0C6' : '#8A97B4', wordBreak: 'break-all' }}>
          {result}
        </div>
      )}
    </div>
  )
}
