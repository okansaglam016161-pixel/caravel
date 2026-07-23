import { useState } from 'react'
import { decryptOwnedUtxo, WasmStealthCrypto, Network } from '@tari-project/ootle'
import type { IndexerGetSubstateResponse } from '@tari-project/ootle'
import { useWallet } from '../../context/WalletContext'
// TEMPORARY — M7.0 SMOKE TEST · REMOVE BEFORE SHIPPING
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import * as nip19 from 'nostr-tools/nip19'
// TEMPORARY — M7.1 GIFT WRAP TEST · REMOVE BEFORE SHIPPING
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

// ── Main component ────────────────────────────────────────────────────────────

// TEMPORARY — M7.0 SMOKE TEST · REMOVE BEFORE SHIPPING
// Computed once on mount: generates a fresh random key pair via nostr-tools
// and round-trips the M6 npub through nip19.decode → nip19.npubEncode.
interface SmokeResult {
  randomNpub: string | null
  roundTripOk: boolean | null
  roundTripNpub: string | null
  error: string | null
}

function runSmokeTest(nostrNpub: string | null): SmokeResult {
  try {
    // Test 1: random key generation
    const sk = generateSecretKey()
    const pkHex = getPublicKey(sk)
    const randomNpub = nip19.npubEncode(pkHex)

    // Test 2: round-trip our M6 npub through nostr-tools nip19
    let roundTripOk: boolean | null = null
    let roundTripNpub: string | null = null
    if (nostrNpub) {
      const decoded = nip19.decode(nostrNpub)
      if (decoded.type !== 'npub') throw new Error(`nip19.decode returned type "${decoded.type}", expected "npub"`)
      roundTripNpub = nip19.npubEncode(decoded.data)
      roundTripOk = roundTripNpub === nostrNpub
    }

    return { randomNpub, roundTripOk, roundTripNpub, error: null }
  } catch (e) {
    return { randomNpub: null, roundTripOk: null, roundTripNpub: null, error: e instanceof Error ? e.message : String(e) }
  }
}

// TEMPORARY — M7.1 GIFT WRAP TEST · REMOVE BEFORE SHIPPING
interface GiftWrapCheck {
  status: 'PASS' | 'FAIL'
  detail: string
}
interface GiftWrapTestResult {
  check1: GiftWrapCheck  // round-trip: A wraps to B, B reads plaintext + sender
  check2: GiftWrapCheck  // negative: C cannot unwrap B's gift wrap
  check3: GiftWrapCheck  // metadata: kind=1059, anon pubkey, randomised past timestamp
  check4: GiftWrapCheck  // unlinkability: two wraps differ in pubkey and id
  fatalError: string | null
}

function runGiftWrapTest(): GiftWrapTestResult {
  const fail = (detail: string): GiftWrapCheck => ({ status: 'FAIL', detail })
  const pass = (detail: string): GiftWrapCheck => ({ status: 'PASS', detail })
  const init: GiftWrapTestResult = {
    check1: fail('not run'),
    check2: fail('not run'),
    check3: fail('not run'),
    check4: fail('not run'),
    fatalError: null,
  }
  try {
    const skA = generateSecretKey()
    const pkA = getPublicKey(skA)
    const skB = generateSecretKey()
    const pkB = getPublicKey(skB)
    const skC = generateSecretKey()
    const msg = 'NIP-17 M7.1 round-trip test'
    const wrap1 = wrapMessage(skA, pkB, msg)

    // Check 1 — round-trip
    try {
      const { senderPubkeyHex, plaintext } = unwrapMessage(skB, wrap1)
      const textOk = plaintext === msg
      const senderOk = senderPubkeyHex === pkA
      init.check1 = textOk && senderOk
        ? pass(`plaintext matches · sender ${pkA.slice(0, 8)}… verified`)
        : fail(`textOk=${textOk} senderOk=${senderOk}`)
    } catch (e) { init.check1 = fail(String(e)) }

    // Check 2 — negative: third-party C must not decrypt
    try {
      unwrapMessage(skC, wrap1)
      init.check2 = fail('C succeeded — expected throw (wrong key)')
    } catch {
      init.check2 = pass('C cannot decrypt — nip44 invalid MAC as expected')
    }

    // Check 3 — metadata: kind 1059, anonymous pubkey, randomised past timestamp
    try {
      const now = Math.round(Date.now() / 1000)
      const twoDays = 172800
      const kindOk = wrap1.kind === 1059
      const pubkeyAnon = wrap1.pubkey !== pkA && wrap1.pubkey !== pkB
      const tsOk = wrap1.created_at <= now && wrap1.created_at >= now - twoDays
      init.check3 = kindOk && pubkeyAnon && tsOk
        ? pass(`kind=${wrap1.kind} · pubkey≠A,B · ts=${wrap1.created_at}≤now`)
        : fail(`kind=${wrap1.kind} pubkeyAnon=${pubkeyAnon} tsOk=${tsOk}`)
    } catch (e) { init.check3 = fail(String(e)) }

    // Check 4 — unlinkability: two wraps of the same content differ in pubkey + id
    try {
      const wrap2 = wrapMessage(skA, pkB, msg)
      const pubkeysDiffer = wrap1.pubkey !== wrap2.pubkey
      const idsDiffer = wrap1.id !== wrap2.id
      init.check4 = pubkeysDiffer && idsDiffer
        ? pass('two wraps have distinct random pubkeys and ids')
        : fail(`pubkeysDiffer=${pubkeysDiffer} idsDiffer=${idsDiffer}`)
    } catch (e) { init.check4 = fail(String(e)) }

  } catch (e) {
    init.fatalError = e instanceof Error ? e.message : String(e)
  }
  return init
}

export default function DecryptPanel() {
  const { wallet, nostrNpub } = useWallet()
  const [utxoId, setUtxoId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ amount: string; memo: DecodedMemo | null } | null>(null)
  // TEMPORARY — M7.0 SMOKE TEST · REMOVE BEFORE SHIPPING
  const [smoke] = useState<SmokeResult>(() => runSmokeTest(nostrNpub))
  // TEMPORARY — M7.1 GIFT WRAP TEST · REMOVE BEFORE SHIPPING
  const [giftWrap] = useState<GiftWrapTestResult>(() => runGiftWrapTest())

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

      {/* TEMPORARY — M6.2 proof, remove before shipping */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px', borderRadius: 10, background: 'rgba(255,200,0,0.06)', border: '2px dashed rgba(255,200,0,0.4)' }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#B89A00', letterSpacing: '0.14em' }}>
          ⚠ TEMPORARY — M6.2 PROOF · REMOVE BEFORE SHIPPING
        </div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.14em', marginTop: 4 }}>
          NOSTR NPUB (NIP-06 · m/44&#x27;/1237&#x27;/0&#x27;/0/0)
        </div>
        <div style={{
          padding: '10px 13px', borderRadius: 8, background: '#10151F',
          border: '1px solid rgba(255,200,0,0.2)',
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: nostrNpub ? '#FFE066' : '#55617D',
          wordBreak: 'break-all', lineHeight: 1.5,
        }}>
          {nostrNpub ?? '(wallet locked)'}
        </div>
      </div>

      {/* TEMPORARY — M7.0 SMOKE TEST · REMOVE BEFORE SHIPPING */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px', borderRadius: 10, background: 'rgba(100,180,255,0.05)', border: '2px dashed rgba(100,180,255,0.35)' }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#5599CC', letterSpacing: '0.14em' }}>
          ⚠ TEMPORARY — M7.0 SMOKE TEST · REMOVE BEFORE SHIPPING
        </div>
        {smoke.error ? (
          <div style={{ fontSize: 12, color: '#FF6B6B', fontFamily: "'IBM Plex Mono', monospace", wordBreak: 'break-all', lineHeight: 1.5 }}>
            FAIL — {smoke.error}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.14em' }}>
                RANDOM KEY GEN (nostr-tools generateSecretKey → npubEncode)
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: smoke.randomNpub ? '#66BBFF' : '#55617D', wordBreak: 'break-all', lineHeight: 1.5, padding: '8px 10px', borderRadius: 6, background: '#10151F' }}>
                {smoke.randomNpub ?? '—'}
              </div>
              <div style={{ fontSize: 11, color: smoke.randomNpub ? '#4EC9A0' : '#FF6B6B', fontFamily: "'IBM Plex Mono', monospace" }}>
                {smoke.randomNpub ? 'PASS ✓ nostr-tools loaded and generated a valid npub' : 'FAIL ✗'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.14em' }}>
                ROUND-TRIP (M6 npub → nip19.decode → nip19.npubEncode → compare)
              </div>
              {nostrNpub == null ? (
                <div style={{ fontSize: 11, color: '#55617D', fontFamily: "'IBM Plex Mono', monospace" }}>
                  SKIPPED — wallet locked (unlock to test)
                </div>
              ) : (
                <>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: smoke.roundTripOk ? '#66BBFF' : '#FF6B6B', wordBreak: 'break-all', lineHeight: 1.5, padding: '8px 10px', borderRadius: 6, background: '#10151F' }}>
                    {smoke.roundTripNpub ?? '—'}
                  </div>
                  <div style={{ fontSize: 11, color: smoke.roundTripOk ? '#4EC9A0' : '#FF6B6B', fontFamily: "'IBM Plex Mono', monospace" }}>
                    {smoke.roundTripOk
                      ? 'PASS ✓ nostr-tools nip19 round-trip matches M6 npub'
                      : 'FAIL ✗ round-trip mismatch'}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* TEMPORARY — M7.1 GIFT WRAP TEST · REMOVE BEFORE SHIPPING */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px', borderRadius: 10, background: 'rgba(100,255,160,0.04)', border: '2px dashed rgba(80,220,130,0.35)' }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#3A9E6A', letterSpacing: '0.14em' }}>
          ⚠ TEMPORARY — M7.1 NIP-17 GIFT WRAP TEST · REMOVE BEFORE SHIPPING
        </div>
        {giftWrap.fatalError ? (
          <div style={{ fontSize: 12, color: '#FF6B6B', fontFamily: "'IBM Plex Mono', monospace", wordBreak: 'break-all', lineHeight: 1.5 }}>
            FATAL — {giftWrap.fatalError}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {([
              ['1', 'ROUND-TRIP (A→B decrypt, plaintext + sender verified)', giftWrap.check1],
              ["2", "NEGATIVE (C cannot decrypt B's gift wrap)", giftWrap.check2],
              ['3', 'METADATA (kind=1059, anon pubkey, past timestamp)', giftWrap.check3],
              ['4', 'UNLINKABILITY (two wraps → distinct pubkeys + ids)', giftWrap.check4],
            ] as [string, string, GiftWrapCheck][]).map(([n, label, chk]) => (
              <div key={n} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: '#55617D', letterSpacing: '0.12em' }}>
                  CHECK {n} — {label}
                </div>
                <div style={{ fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", color: chk.status === 'PASS' ? '#4EC9A0' : '#FF6B6B', lineHeight: 1.5, wordBreak: 'break-all' }}>
                  {chk.status} {chk.status === 'PASS' ? '✓' : '✗'} {chk.detail}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dev-panel notice */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 10, background: 'rgba(120,150,210,0.06)', border: '1px solid rgba(120,150,210,0.16)' }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8A97B4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
          <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
        </svg>
        <span style={{ fontSize: 12, color: '#8A97B4', lineHeight: 1.5 }}>
          Dev panel — paste a UTXO substate ID to decrypt it with this wallet's view key. No scanner yet; scanning is Level 2.
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
