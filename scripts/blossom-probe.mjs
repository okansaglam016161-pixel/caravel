// Blossom host probe (image attachments M2, task 1).
//
// Answers ONE question, empirically, before any client code is written on top of it:
//   which Blossom hosts actually accept an AES-GCM CIPHERTEXT — opaque application/octet-stream
//   with no magic bytes — as opposed to only sniffable image/video?
//
// This is not a formality. blossom.band documents an extension allowlist (.jpg/.png/.mp4/…) and
// rejects uploads containing GPS metadata, which means it inspects content; blossom-server's
// documented behaviour is 415 Unsupported Media Type when a blob matches no MIME rule. Encrypted
// bytes sniff as nothing, so a guessed default could 415 every upload.
//
// It also reports the CORS headers each host returns for the browser preflight, but NOTE: Node does
// not enforce CORS, so a pass here is necessary and NOT sufficient. The definitive check is the
// browser probe (scripts/blossom-probe.html) — a PUT carrying an Authorization header always
// triggers an OPTIONS preflight, and a host that sets the GET headers but not the OPTIONS ones will
// work from here and fail from the app.
//
// Run: node scripts/blossom-probe.mjs
// Deliberately outside `npm test` — it hits the real network.

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

// Override from the command line to probe a different batch:
//   node scripts/blossom-probe.mjs https://a.example https://b.example
const HOSTS = process.argv.length > 2 ? process.argv.slice(2) : [
  'https://blossom.band',
  'https://blossom.nostr.build',
  'https://blossom.primal.net',
  'https://cdn.satellite.earth',
  'https://nostr.download',
  'https://blossom.f7z.io',
  'https://cdn.sovbit.host',
  'https://blossom.oxtr.dev',
  'https://media.lumina.rocks',
  'https://nostrcheck.me',
]

const TIMEOUT_MS = 20_000
// A browser origin the hosts have never seen, so the CORS answer isn't skewed by an allowlist.
const ORIGIN = 'http://localhost:5173'

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes))

// base64url, no padding — BUD-11's stated encoding ("as used by JWTs").
const b64url = str => Buffer.from(str, 'utf8').toString('base64url')
// Standard base64 — what some servers actually implemented. Probed as a fallback so we learn which
// encoding each host really wants rather than guessing.
const b64std = str => Buffer.from(str, 'utf8').toString('base64')

// Build a real encrypted blob: random 256-bit key + 96-bit nonce, AES-GCM over a small payload.
// This is byte-for-byte the kind of body the app will upload — random-looking, no file signature.
async function makeCiphertext() {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  // ~4 KB of pseudo-image plaintext; small enough to be polite, big enough to be a real upload.
  const plaintext = crypto.getRandomValues(new Uint8Array(4096))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext)
  return new Uint8Array(ciphertext)
}

// BUD-11 authorization event, signed by a FRESH EPHEMERAL KEY — never the user's identity, so the
// host cannot link an upload to a Caravel user or to any other upload.
function authToken(sha256hex, encode) {
  const sk = generateSecretKey()
  const now = Math.floor(Date.now() / 1000)
  const event = finalizeEvent({
    kind: 24242,
    created_at: now,
    content: 'Upload encrypted image',
    tags: [
      ['t', 'upload'],
      ['expiration', String(now + 300)],
      ['x', sha256hex],
    ],
  }, sk)
  return { token: encode(JSON.stringify(event)), pubkey: getPublicKey(sk) }
}

async function withTimeout(fn) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try { return await fn(ctrl.signal) } finally { clearTimeout(timer) }
}

// What the browser will send before the real PUT. Reported, not enforced (Node ignores CORS).
async function preflight(host) {
  try {
    const res = await withTimeout(signal => fetch(`${host}/upload`, {
      method: 'OPTIONS',
      signal,
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    }))
    return {
      status: res.status,
      allowOrigin: res.headers.get('access-control-allow-origin'),
      allowMethods: res.headers.get('access-control-allow-methods'),
      allowHeaders: res.headers.get('access-control-allow-headers'),
    }
  } catch (e) {
    return { status: 'ERR', error: e.name === 'AbortError' ? 'timeout' : e.message }
  }
}

async function tryUpload(host, bytes, digest, encode, label) {
  const { token, pubkey } = authToken(digest, encode)
  const res = await withTimeout(signal => fetch(`${host}/upload`, {
    method: 'PUT',
    signal,
    headers: {
      Authorization: `Nostr ${token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
      Origin: ORIGIN,
    },
    body: bytes,
  }))
  const text = await res.text().catch(() => '')
  return { encoding: label, status: res.status, ok: res.ok, body: text.slice(0, 300), pubkey }
}

async function probe(host) {
  const bytes = await makeCiphertext()
  const digest = await sha256(bytes)
  const result = { host, digest: digest.slice(0, 12) + '…', cors: await preflight(host) }

  // Upload: BUD-11 base64url first, standard base64 as a fallback, so we learn which each host wants.
  let up
  try {
    up = await tryUpload(host, bytes, digest, b64url, 'base64url')
    if (!up.ok && (up.status === 401 || up.status === 403)) {
      const alt = await tryUpload(host, bytes, digest, b64std, 'base64')
      if (alt.ok) up = alt; else up = { ...up, altStatus: alt.status, altBody: alt.body.slice(0, 120) }
    }
  } catch (e) {
    up = { status: 'ERR', ok: false, body: e.name === 'AbortError' ? 'timeout' : e.message }
  }
  result.upload = up
  if (!up.ok) return result

  // Round-trip: fetch it back and confirm the host returned the EXACT bytes. Blossom's contract is
  // that a server MUST NOT modify a blob, and that contract is the whole basis for storing
  // ciphertext — a host that transcodes would silently destroy every image.
  try {
    let url
    try { url = JSON.parse(up.body).url } catch { url = null }
    url ??= `${host}/${digest}`
    const res = await withTimeout(signal => fetch(url, { signal, headers: { Origin: ORIGIN } }))
    if (!res.ok) {
      result.download = { status: res.status, ok: false }
    } else {
      const back = new Uint8Array(await res.arrayBuffer())
      const backDigest = await sha256(back)
      result.download = {
        status: res.status,
        ok: true,
        url,
        byteExact: backDigest === digest,
        size: back.length,
        contentType: res.headers.get('content-type'),
        getAllowOrigin: res.headers.get('access-control-allow-origin'),
      }
    }
  } catch (e) {
    result.download = { status: 'ERR', ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message }
  }
  return result
}

const results = await Promise.all(HOSTS.map(h => probe(h).catch(e => ({ host: h, fatal: String(e) }))))

console.log('\n════ BLOSSOM CIPHERTEXT PROBE ════\n')
for (const r of results) {
  const u = r.upload ?? {}
  const d = r.download ?? {}
  const verdict = u.ok && d.ok && d.byteExact ? '✅ ACCEPTS CIPHERTEXT'
    : u.ok ? '⚠️  uploaded, round-trip failed'
    : `❌ upload ${u.status}`
  console.log(`${verdict}  ${r.host}`)
  console.log(`   upload   : ${u.status} (${u.encoding ?? 'n/a'})${u.altStatus ? ` | base64 alt: ${u.altStatus}` : ''}`)
  if (!u.ok && u.body) console.log(`   body     : ${u.body.replace(/\s+/g, ' ').slice(0, 160)}`)
  if (d.ok !== undefined) console.log(`   download : ${d.status} byteExact=${d.byteExact} type=${d.contentType} acao=${d.getAllowOrigin}`)
  console.log(`   preflight: ${r.cors.status} acao=${r.cors.allowOrigin} methods=${r.cors.allowMethods} headers=${r.cors.allowHeaders}`)
  if (d.url) console.log(`   url      : ${d.url}`)
  console.log()
}
const winners = results.filter(r => r.upload?.ok && r.download?.byteExact).map(r => r.host)
console.log('════ ACCEPTS ENCRYPTED BLOBS:', winners.length ? winners.join(', ') : 'NONE', '════\n')
