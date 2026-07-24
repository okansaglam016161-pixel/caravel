import { useState } from 'react'
import { decryptOwnedUtxo, WasmStealthCrypto, Network } from '@tari-project/ootle'
import type { IndexerGetSubstateResponse } from '@tari-project/ootle'
import { useWallet } from '../../context/WalletContext'
// TEMPORARY — M10.0 PAYMENT-TAG TEST · REMOVE BEFORE SHIPPING
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { getConversationKey, decrypt as nip44Decrypt } from 'nostr-tools/nip44'
import { wrapMessage, unwrapMessage } from '../../crypto/nostrMessaging'

// ── Constants ─────────────────────────────────────────────────────────────────

const INDEXER = 'https://ootle-indexer-a.tari.com'

// One shared crypto instance — no per-call allocation.
const crypto = new WasmStealthCrypto(Network.Esmeralda)

// ── Memo decoding ─────────────────────────────────────────────────────────────

// PayRefAndBytes wire: [1-byte N][N-byte pay_ref UTF-8][remaining bytes: message UTF-8]
// (see RECIPE.md §6 / §10)

interface PayRefMemo { kind: 'payref'; payRef: string; message: string }
interface MessageMemo { kind: 'message'; message: string }
interface RawMemo    { kind: 'raw'; raw: string }

type DecodedMemo = PayRefMemo | MessageMemo | RawMemo

function decodeMemo(memoJson: string | undefined): DecodedMemo | null {
  if (!memoJson) return null
  let parsed: unknown
  try { parsed = JSON.parse(memoJson) } catch { return { kind: 'raw', raw: memoJson } }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'raw', raw: memoJson }
  const p = parsed as Record<string, unknown>
  if (typeof p.PayRefAndBytes === 'string') {
    const hex = p.PayRefAndBytes
    const bytes = new Uint8Array((hex.match(/.{2}/g) ?? []).map((b: string) => parseInt(b, 16)))
    const n = bytes[0]
    const dec = new TextDecoder()
    return {
      kind: 'payref',
      payRef: dec.decode(bytes.slice(1, 1 + n)),
      message: dec.decode(bytes.slice(1 + n)),
    }
  }
  if (typeof p.Message === 'string') return { kind: 'message', message: p.Message }
  if (typeof p.Bytes === 'string')   return { kind: 'raw', raw: p.Bytes }
  if (typeof p.U256 === 'string')    return { kind: 'raw', raw: `U256: ${p.U256}` }
  return { kind: 'raw', raw: memoJson }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.14em' }}>
        {label}
      </div>
      <div style={{
        padding: '10px 13px', borderRadius: 10, background: '#10151F',
        border: '1px solid rgba(45,224,198,0.18)',
        fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: '#EAFBF7',
        wordBreak: 'break-all', lineHeight: 1.5,
      }}>
        {value}
      </div>
    </div>
  )
}

// TEMPORARY — M10.0 PAYMENT-TAG TEST · REMOVE BEFORE SHIPPING
// Offline proof (no relay) that a message carries a payment reference on the encrypted rumor,
// round-trips intact, degrades gracefully without one, and never leaks the reference onto the
// outer gift wrap where relays could see it.
interface PayTagCheck { status: 'PASS' | 'FAIL'; detail: string }
interface PayTagTestResult {
  check1: PayTagCheck  // with-payment round trip: plaintext + payment come back
  check2: PayTagCheck  // without-payment round trip: plaintext intact, payment undefined
  check3: PayTagCheck  // raw rumor tags carry ["caravel-payment","v1",<id>]
  check4: PayTagCheck  // payment reference NOT on the outer gift wrap
  rumorTags: string    // decrypted rumor tags, shown for inspection
  wrapTags: string     // outer gift wrap tags, shown for inspection
  fatalError: string | null
}

function runPayTagTest(): PayTagTestResult {
  const fail = (detail: string): PayTagCheck => ({ status: 'FAIL', detail })
  const pass = (detail: string): PayTagCheck => ({ status: 'PASS', detail })
  const init: PayTagTestResult = {
    check1: fail('not run'), check2: fail('not run'), check3: fail('not run'), check4: fail('not run'),
    rumorTags: '', wrapTags: '', fatalError: null,
  }
  try {
    const skA = generateSecretKey(); const pkA = getPublicKey(skA)
    const skB = generateSecretKey(); const pkB = getPublicKey(skB)
    const note = 'Here is my half for lunch — thanks!'
    const utxoId = 'utxo_0101010101010101010101010101010101010101010101010101010101010101_commitment_deadbeef'

    // WITH payment
    const wrapWith = wrapMessage(skA, pkB, note, { utxoId })
    const uWith = unwrapMessage(skB, wrapWith)
    init.check1 = uWith.plaintext === note && uWith.payment?.utxoId === utxoId
      ? pass(`plaintext + payment utxoId "${utxoId.slice(0, 18)}…" recovered · sender ${pkA.slice(0, 8)}…`)
      : fail(`plaintext=${uWith.plaintext === note} payment=${uWith.payment?.utxoId}`)

    // WITHOUT payment
    const wrapNone = wrapMessage(skA, pkB, note)
    const uNone = unwrapMessage(skB, wrapNone)
    init.check2 = uNone.plaintext === note && uNone.payment === undefined
      ? pass('plaintext intact · payment is undefined (nothing breaks)')
      : fail(`plaintext=${uNone.plaintext === note} payment=${JSON.stringify(uNone.payment)}`)

    // Raw rumor tags — manually decrypt both layers of wrapWith to inspect the structure
    const sealKey = getConversationKey(skB, wrapWith.pubkey)
    const seal = JSON.parse(nip44Decrypt(wrapWith.content, sealKey)) as { pubkey: string; content: string }
    const rumorKey = getConversationKey(skB, seal.pubkey)
    const rumor = JSON.parse(nip44Decrypt(seal.content, rumorKey)) as { tags: string[][] }
    init.rumorTags = JSON.stringify(rumor.tags)
    const tagOk = rumor.tags.some(t => t[0] === 'caravel-payment' && t[1] === 'v1' && t[2] === utxoId)
    init.check3 = tagOk
      ? pass('rumor carries ["caravel-payment","v1",<id>]')
      : fail(`rumor tags: ${init.rumorTags}`)

    // NOT on the outer gift wrap — tags AND the full serialized event must not contain it
    init.wrapTags = JSON.stringify(wrapWith.tags)
    const notInTags = !wrapWith.tags.some(t => t[0] === 'caravel-payment')
    const notInEvent = !JSON.stringify(wrapWith).includes(utxoId) && !JSON.stringify(wrapWith).includes('caravel-payment')
    init.check4 = notInTags && notInEvent
      ? pass('gift wrap exposes only the ["p",…] tag; reference is sealed, invisible to relays')
      : fail(`notInTags=${notInTags} notInEvent=${notInEvent} wrapTags=${init.wrapTags}`)
  } catch (e) {
    init.fatalError = e instanceof Error ? e.message : String(e)
  }
  return init
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DecryptPanel() {
  const { wallet } = useWallet()
  const [utxoId, setUtxoId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ amount: string; memo: DecodedMemo | null } | null>(null)
  // TEMPORARY — M10.0 PAYMENT-TAG TEST · REMOVE BEFORE SHIPPING
  const [payTest] = useState<PayTagTestResult>(() => runPayTagTest())

  const canDecrypt = !!wallet && utxoId.trim().startsWith('utxo_') && !loading

  async function handleDecrypt() {
    if (!wallet || !canDecrypt) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const viewSecret = wallet.getViewOnlySecret()
      if (!viewSecret) throw new Error('Wallet has no view key — unlock a wallet with a view secret first')

      const id = utxoId.trim()
      const resp = await fetch(`${INDEXER}/substates/${encodeURIComponent(id)}`)
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`Indexer ${resp.status}: ${body || resp.statusText}`)
      }
      const substate = await resp.json() as IndexerGetSubstateResponse

      const decrypted = await decryptOwnedUtxo(crypto, viewSecret, substate, id)
      if (decrypted === null) {
        throw new Error('This UTXO does not belong to this wallet (AEAD decryption failed — wrong view key or not your output)')
      }

      const tTARI = (Number(decrypted.value) / 1_000_000).toFixed(6)
      setResult({ amount: `${tTARI} tTARI`, memo: decodeMemo(decrypted.memo) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: '24px 24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* TEMPORARY — M10.0 PAYMENT-TAG TEST · REMOVE BEFORE SHIPPING */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px', borderRadius: 10, background: 'rgba(45,224,198,0.04)', border: '2px dashed rgba(45,224,198,0.35)' }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#2D9E8C', letterSpacing: '0.14em' }}>
          ⚠ TEMPORARY — M10.0 PAYMENT-TAG ROUND-TRIP · REMOVE BEFORE SHIPPING
        </div>
        {payTest.fatalError ? (
          <div style={{ fontSize: 12, color: '#FF6B6B', fontFamily: "'IBM Plex Mono', monospace", wordBreak: 'break-all', lineHeight: 1.5 }}>
            FATAL — {payTest.fatalError}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {([
              ['1', 'WITH PAYMENT (wrap → unwrap: plaintext + payment)', payTest.check1],
              ['2', 'WITHOUT PAYMENT (plaintext intact, payment undefined)', payTest.check2],
              ['3', 'RUMOR TAG (["caravel-payment","v1",<id>] present)', payTest.check3],
              ['4', 'NOT ON GIFT WRAP (reference sealed, invisible to relays)', payTest.check4],
            ] as [string, string, PayTagCheck][]).map(([n, label, chk]) => (
              <div key={n} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.12em' }}>
                  CHECK {n} — {label}
                </div>
                <div style={{ fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", color: chk.status === 'PASS' ? '#4EC9A0' : '#FF6B6B', lineHeight: 1.5, wordBreak: 'break-all' }}>
                  {chk.status} {chk.status === 'PASS' ? '✓' : '✗'} {chk.detail}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.12em' }}>
                RUMOR TAGS (decrypted — inside the seal)
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#7DE9D8', wordBreak: 'break-all', lineHeight: 1.5, padding: '8px 10px', borderRadius: 6, background: '#10151F' }}>
                {payTest.rumorTags || '—'}
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.12em', marginTop: 4 }}>
                GIFT WRAP TAGS (outer event — what relays see)
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#8A97B4', wordBreak: 'break-all', lineHeight: 1.5, padding: '8px 10px', borderRadius: 6, background: '#10151F' }}>
                {payTest.wrapTags || '—'}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Dev-panel notice */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 10, background: 'rgba(120,150,210,0.06)', border: '1px solid rgba(120,150,210,0.16)' }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
          <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
        </svg>
        <span style={{ fontSize: 12, color: '#8A97B4', lineHeight: 1.5 }}>
          Dev tool — paste a UTXO substate ID to fetch it from the indexer and decrypt its amount and memo with this wallet's view key. The wallet panel scans for your UTXOs automatically; this is for inspecting a specific one by ID.
        </span>
      </div>

      {/* Input */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.14em' }}>
          UTXO SUBSTATE ID
        </div>
        <textarea
          value={utxoId}
          onChange={e => { setUtxoId(e.target.value); setError(''); setResult(null) }}
          placeholder="utxo_0101…0101_<commitment>"
          rows={3}
          style={{
            background: '#10151F',
            border: `1px solid ${utxoId ? 'rgba(45,224,198,0.3)' : 'rgba(120,150,210,0.16)'}`,
            borderRadius: 11, padding: '12px 14px',
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: '#E4EAF4',
            resize: 'vertical', outline: 'none', lineHeight: 1.5, width: '100%',
            boxSizing: 'border-box',
            transition: 'border-color 0.15s',
          }}
          spellCheck={false}
        />
      </div>

      {/* Decrypt button */}
      <button
        onClick={handleDecrypt}
        disabled={!canDecrypt}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: '14px 20px', borderRadius: 12, border: 'none',
          background: canDecrypt
            ? 'linear-gradient(180deg, var(--accB,#34E5D0), var(--accD,#12A594))'
            : 'rgba(120,150,210,0.15)',
          color: canDecrypt ? 'var(--accOn,#04120F)' : '#55617D',
          fontSize: 15, fontWeight: 700, cursor: canDecrypt ? 'pointer' : 'default',
          transition: 'all 0.15s',
        }}
      >
        {loading ? (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            Decrypting…
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
            Decrypt UTXO
          </>
        )}
      </button>

      {/* Error */}
      {error && (
        <div style={{ fontSize: 13, color: '#FF6B6B', padding: '12px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: 'rgba(45,224,198,0.06)', border: '1px solid rgba(45,224,198,0.25)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--acc,#2DE0C6)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 7l-8 8-4-4" />
            </svg>
            <span style={{ fontSize: 13, color: 'var(--acc,#2DE0C6)', fontWeight: 600 }}>Decrypted — this output belongs to this wallet</span>
          </div>

          <Field label="AMOUNT" value={result.amount} />

          {result.memo?.kind === 'payref' && (
            <>
              <Field label="PAY_REF" value={result.memo.payRef} />
              <Field label="MESSAGE" value={result.memo.message} />
            </>
          )}
          {result.memo?.kind === 'message' && (
            <Field label="MESSAGE" value={result.memo.message} />
          )}
          {result.memo?.kind === 'raw' && (
            <Field label="MEMO (RAW)" value={result.memo.raw} />
          )}
          {result.memo === null && (
            <Field label="MEMO" value="(none)" />
          )}
        </div>
      )}

      {/* Spinner keyframe */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
