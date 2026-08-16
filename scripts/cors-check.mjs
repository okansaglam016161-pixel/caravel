// CORS analysis for the hosts that accepted ciphertext (M2 probe, part 2).
//
// Node does not enforce CORS, so this cannot PROVE the browser will allow the upload — but the
// browser's decision is a pure function of the preflight response headers, so we can evaluate the
// same rules the browser applies and report exactly which clause each host satisfies or breaks.
//
// The rules that matter for our request (PUT + Authorization + Content-Type: application/octet-stream
// is NEVER a "simple request", so a preflight is mandatory):
//   1. preflight status must be 2xx
//   2. Access-Control-Allow-Origin must be `*` or echo our origin
//   3. Access-Control-Allow-Methods must include PUT
//   4. Access-Control-Allow-Headers must cover `authorization` AND `content-type`
//      ⚠️  SPEC vs REALITY, established empirically on 2026-08-16 — read this before trusting the
//          verdict below. The Fetch standard says a bare `*` does NOT cover Authorization (it must
//          be listed by name), and this script reports on that basis. But NO SHIPPING BROWSER
//          ENFORCES IT: per caniuse, Chrome ≤154, Edge ≤151 and Safari ≤27 don't implement the
//          carve-out and Firefox 115+ keeps it behind a disabled-by-default flag (0% global usage).
//          files.sovbit.host returns only `*` and its authorised PUT nonetheless SUCCEEDED in a real
//          browser. So a "BROWSER WOULD BLOCK" verdict here means "spec-noncompliant, and will break
//          when browsers catch up" — NOT "broken today". Treat it as a durability warning, and let
//          scripts/blossom-probe.html be the authority on what actually works right now.
//   5. the actual PUT response, and the later cross-origin GET, each need Access-Control-Allow-Origin
//      for us to read them.

const HOSTS = process.argv.slice(2)
const ORIGIN = 'http://localhost:5173'

function coversHeader(allowHeaders, name) {
  if (!allowHeaders) return false
  const list = allowHeaders.toLowerCase().split(',').map(s => s.trim())
  if (list.includes(name)) return true
  // Wildcard covers ordinary headers but NEVER Authorization (Fetch standard carves it out
  // explicitly), which is why a host can look permissive and still block an authorised upload.
  return list.includes('*') && name !== 'authorization'
}

// `*` IS a valid wildcard for Allow-Methods on a non-credentialed request, unlike the header case.
function coversMethod(allowMethods, method) {
  if (!allowMethods) return false
  const list = allowMethods.toLowerCase().split(',').map(s => s.trim())
  return list.includes(method) || list.includes('*')
}

// Does this host accept an upload with NO Authorization header at all? It matters for CORS: without
// that header the preflight only has to allow content-type, which a bare `*` DOES cover — so a host
// that blocks an authorised upload may still be usable anonymously.
async function anonymousUploadWorks(host) {
  try {
    const body = crypto.getRandomValues(new Uint8Array(1024))
    const res = await fetch(`${host}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', Origin: ORIGIN },
      body,
    })
    return `${res.status}${res.ok ? ' (ACCEPTED anonymously)' : ''}`
  } catch (e) {
    return `ERR ${e.message}`
  }
}

for (const host of HOSTS) {
  console.log(`\n──── ${host}`)
  try {
    const pre = await fetch(`${host}/upload`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    })
    const acao = pre.headers.get('access-control-allow-origin')
    const acam = pre.headers.get('access-control-allow-methods')
    const acah = pre.headers.get('access-control-allow-headers')

    const checks = [
      ['preflight 2xx', pre.status >= 200 && pre.status < 300, pre.status],
      ['allow-origin', acao === '*' || acao === ORIGIN, acao],
      ['allow PUT', coversMethod(acam, 'put'), acam],
      ['allow authorization', coversHeader(acah, 'authorization'), acah],
      ['allow content-type', coversHeader(acah, 'content-type'), acah],
    ]
    for (const [name, pass, detail] of checks) {
      console.log(`  ${pass ? '✓' : '✗'} ${name.padEnd(20)} ${String(detail).slice(0, 120)}`)
    }
    // A cross-origin GET of the blob is a simple request, but its RESPONSE still needs ACAO to be
    // readable by our script.
    const get = await fetch(`${host}/0000000000000000000000000000000000000000000000000000000000000000`, {
      headers: { Origin: ORIGIN },
    })
    const getAcao = get.headers.get('access-control-allow-origin')
    console.log(`  ${getAcao === '*' || getAcao === ORIGIN ? '✓' : '✗'} GET allow-origin      ${getAcao} (probe status ${get.status})`)
    const getOk = getAcao === '*' || getAcao === ORIGIN
    console.log(`  · anonymous upload    ${await anonymousUploadWorks(host)}`)
    console.log(`  VERDICT: ${checks.every(c => c[1]) && getOk ? 'browser upload SHOULD work' : 'BROWSER WOULD BLOCK (authorised upload)'}`)
  } catch (e) {
    console.log(`  ✗ unreachable: ${e.message}`)
  }
}
console.log()
