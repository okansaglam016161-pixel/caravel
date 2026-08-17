// Relay capability check — does a relay ACCEPT and then DELIVER a kind-1059 gift wrap?
//
// The bar M7.2 held relay.damus.io and relay.primal.net to, applied to any candidate before it goes
// in DEFAULT_RELAYS. "Connected" is not the bar: a relay can accept a WebSocket, accept the event
// with an OK, and still never serve it to a subscriber — in which case every message routed through
// it is silently lost. relay.primal.net does exactly that, which is why it is no longer in
// src/config/relays.ts — see the rationale recorded in that file's header.
//
//   node scripts/relay-verify.mjs                  # the Level 1 candidate set + primal control
//   node scripts/relay-verify.mjs wss://a wss://b  # explicit list
//   ROUNDS=5 node scripts/relay-verify.mjs         # more rounds (default 3)
//
// Offline diagnostic. Throwaway keypair PER RELAY PER ROUND, no app state, no localStorage, nothing
// written. Deliberately NOT part of `npm test` — it hits the real network.

import { Relay } from 'nostr-tools/relay'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { wrapEvent } from 'nostr-tools/nip59'

// Level 1 candidate set. damus / nos.lol / snort are the known-good anchors, carried so every run
// re-establishes the baseline rather than trusting a previous run's numbers.
const CANDIDATES = [
  { url: 'wss://relay.damus.io', role: 'anchor (known good)' },
  { url: 'wss://nos.lol', role: 'anchor (known good)' },
  { url: 'wss://relay.snort.social', role: 'anchor (known good)' },
  { url: 'wss://relay.nostr.bg', role: 'candidate' },
  { url: 'wss://nostr.mom', role: 'candidate' },
  { url: 'wss://relay.nostr.wirednet.jp', role: 'candidate' },
  { url: 'wss://nostr.wine', role: 'candidate' },
  { url: 'wss://relay.mostr.pub', role: 'candidate' },
  { url: 'wss://offchain.pub', role: 'candidate' },
  { url: 'wss://relay.nostr.net', role: 'candidate' },
  { url: 'wss://nostr21.com', role: 'candidate' },
  { url: 'wss://relay.primal.net', role: 'control (known BAD delivery — has it recovered?)' },
]

const TARGETS = process.argv.length > 2
  ? process.argv.slice(2).map(url => ({ url, role: 'candidate' }))
  : CANDIDATES

const ROUNDS = Number(process.env.ROUNDS ?? 3)

const CONNECT_TIMEOUT = 10_000   // same budget the app uses
const PUBLISH_TIMEOUT = 9_000    // app: timeoutMs * 0.9
const DELIVER_TIMEOUT = 15_000   // generous — we care whether it arrives at all
const ROUND_GAP_MS = 1_000       // breathing room between a relay's own rounds

// CONNECT RETRIES ARE ESSENTIAL TO THIS TEST'S VALIDITY, not a nicety. Cold-dialling these relays
// fails roughly 30% of the time (measured: 5/8 sequential, 6-7/8 concurrent, per relay), so a
// single-attempt probe conflates "this relay cannot serve kind 1059" with "this dial was unlucky".
// The first version of this script produced exactly that false negative: relay.damus.io and
// relay.primal.net — both PROVEN in production — reported NO on all three columns.
//
// A capability test must therefore retry the transport before concluding anything about the protocol.
const CONNECT_ATTEMPTS = 4
const CONNECT_RETRY_MS = 700

async function connectWithRetry(url) {
  let lastError = 'not attempted'
  for (let i = 0; i < CONNECT_ATTEMPTS; i++) {
    const relay = new Relay(url)
    try {
      await relay.connect({ timeout: CONNECT_TIMEOUT })
      return { relay, attempts: i + 1 }
    } catch (e) {
      lastError = (e?.message ?? e).toString()
      try { relay.close() } catch { /* ignore */ }
      if (i < CONNECT_ATTEMPTS - 1) await new Promise(r => setTimeout(r, CONNECT_RETRY_MS))
    }
  }
  return { relay: null, attempts: CONNECT_ATTEMPTS, error: lastError }
}

// A throwaway identity per relay per round, so no relay's result can be polluted by another's
// events and no round can be satisfied by a previous round's wrap.
function freshWrap() {
  const sender = generateSecretKey()
  const recipient = generateSecretKey()
  const recipientPk = getPublicKey(recipient)
  const wrap = wrapEvent(
    {
      kind: 14,
      created_at: Math.round(Date.now() / 1000),
      content: `relay-verify ${Math.floor(performance.now())}`,
      tags: [['p', recipientPk]],
    },
    sender, recipientPk,
  )
  return { wrap, recipientPk }
}

async function verifyOnce(url) {
  const out = { connects: false, accepts: false, delivers: false, latencyMs: null, note: '', subDials: 0, pubDials: 0 }
  const { wrap, recipientPk } = freshWrap()

  // TWO SEPARATE CONNECTIONS on purpose: one subscribes, one publishes. A single socket could appear
  // to work because the relay echoed our own publish back on the same connection — that is not proof
  // it stored and will serve the event to anyone else.
  let subRelay = null
  let pubRelay = null
  try {
    // 1) SUBSCRIBER FIRST, so a live push cannot be missed.
    {
      const c = await connectWithRetry(url)
      if (!c.relay) {
        out.subDials = c.attempts
        out.note = `subscribe-connect failed after ${CONNECT_ATTEMPTS} attempts: ${(c.error ?? '').slice(0, 60)}`
        return out
      }
      subRelay = c.relay
      out.subDials = c.attempts
    }

    // The delivery clock is ARMED AFTER THE PUBLISH, not here. Arming it at subscribe time is a real
    // false-negative: the publisher's own connect can burn up to CONNECT_ATTEMPTS × CONNECT_TIMEOUT
    // (~42s) before a single byte is published, which would expire a 15s window and report
    // "accepted but never delivered" for a relay that was merely slow to dial — penalising exactly
    // the flaky-dial relays this test is supposed to measure fairly.
    let resolveDelivered
    let deliverTimer = null
    const delivered = new Promise(resolve => { resolveDelivered = resolve })
    const armDeliveryTimeout = () => {
      deliverTimer = setTimeout(() => resolveDelivered(null), DELIVER_TIMEOUT)
    }
    subRelay.subscribe([{ kinds: [1059], '#p': [recipientPk] }], {
      onevent: ev => {
        if (ev.id === wrap.id) { clearTimeout(deliverTimer); resolveDelivered(performance.now()) }
      },
      oneose: () => {},
    })
    // Let the REQ settle before publishing.
    await new Promise(r => setTimeout(r, 800))

    // 2) PUBLISHER on its own connection.
    {
      const c = await connectWithRetry(url)
      if (!c.relay) {
        out.pubDials = c.attempts
        out.note = `publish-connect failed after ${CONNECT_ATTEMPTS} attempts: ${(c.error ?? '').slice(0, 60)}`
        return out
      }
      pubRelay = c.relay
      pubRelay.publishTimeout = PUBLISH_TIMEOUT
      out.connects = true
      out.pubDials = c.attempts
    }

    const sentAt = performance.now()
    try {
      await pubRelay.publish(wrap)
      out.accepts = true
    } catch (e) {
      out.note = `rejected 1059: ${(e?.message ?? e).toString().slice(0, 70)}`
      return out
    }

    // 3) Did it come back to the OTHER connection? Clock starts NOW.
    // (A relay fast enough to push before this line still wins — the promise is already resolved.)
    armDeliveryTimeout()
    const arrivedAt = await delivered
    clearTimeout(deliverTimer)
    if (arrivedAt === null) {
      out.note = `ACCEPTED BUT NEVER DELIVERED within ${DELIVER_TIMEOUT / 1000}s`
    } else {
      out.delivers = true
      out.latencyMs = Math.round(arrivedAt - sentAt)
    }
    return out
  } catch (e) {
    out.note = `unexpected: ${(e?.message ?? e).toString().slice(0, 70)}`
    return out
  } finally {
    for (const r of [subRelay, pubRelay]) { try { r?.close() } catch { /* ignore */ } }
  }
}

const median = xs => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

// Relays are probed CONCURRENTLY; a relay's own rounds run sequentially. Concurrency across relays is
// safe here and was measured to perform *better* than sequential dialling (concurrent connects beat
// sequential ones, so relay dial failure is load-INDEPENDENT and this is not rate-limit evasion).
// It also turns a ~60-minute worst case into a ~5-minute one.
async function verifyRelay({ url, role }, index) {
  await new Promise(r => setTimeout(r, index * 250))   // mild stagger, not a rate-limit workaround
  const rounds = []
  for (let i = 0; i < ROUNDS; i++) {
    const r = await verifyOnce(url)
    rounds.push(r)
    const mark = r.delivers ? `deliver ${r.latencyMs}ms` : r.accepts ? 'ACCEPTED, NO DELIVERY' : r.connects ? 'REJECTED' : 'NO CONNECT'
    process.stdout.write(`  [round ${i + 1}/${ROUNDS}] ${url.replace('wss://', '').padEnd(26)} ${mark}\n`)
    if (i < ROUNDS - 1) await new Promise(r2 => setTimeout(r2, ROUND_GAP_MS))
  }
  const latencies = rounds.filter(r => r.delivers).map(r => r.latencyMs)
  const dials = rounds.flatMap(r => [r.subDials, r.pubDials]).filter(n => n > 0)
  return {
    url, role, rounds,
    connects: rounds.filter(r => r.connects).length,
    accepts: rounds.filter(r => r.accepts).length,
    delivers: rounds.filter(r => r.delivers).length,
    // WHY a round missed matters more than the count. A failed dial is a transport problem: retryable,
    // visible, and already compensated by the publish retry. An accept-with-no-delivery is a LIE —
    // publishGiftWrap records the OK as success and the recipient gets nothing. Never merge these two
    // into one "unreliable" number; they need opposite responses.
    noConnect: rounds.filter(r => !r.connects).length,
    droppedAfterAccept: rounds.filter(r => r.accepts && !r.delivers).length,
    rejected: rounds.filter(r => r.connects && !r.accepts).length,
    medianMs: median(latencies),
    worstMs: latencies.length ? Math.max(...latencies) : null,
    dialMin: dials.length ? Math.min(...dials) : 0,
    dialMax: dials.length ? Math.max(...dials) : 0,
    notes: [...new Set(rounds.map(r => r.note).filter(Boolean))],
  }
}

console.log(`\n  Probing ${TARGETS.length} relays × ${ROUNDS} rounds — real kind-1059 gift wrap, publish and read back`)
console.log(`  on SEPARATE connections, fresh keypair each round, ${CONNECT_ATTEMPTS} connect retries.\n`)

const results = await Promise.all(TARGETS.map((t, i) => verifyRelay(t, i)))

const n = ROUNDS
console.log('\n════════ kind-1059 GIFT WRAP ROUND-TRIP ════════\n')
console.log(`  relay                       connects  accepts 1059  delivers 1059  median    worst     dials   role`)
console.log('  ' + '-'.repeat(118))
// Report in the input order so the anchors stay at the top for comparison.
for (const r of results) {
  console.log(
    '  ' +
    r.url.replace('wss://', '').padEnd(27) +
    `${r.connects}/${n}`.padEnd(10) +
    `${r.accepts}/${n}`.padEnd(14) +
    (`${r.delivers}/${n}` + (r.delivers === n ? '' : ' ⚠')).padEnd(15) +
    (r.medianMs === null ? '—' : `${r.medianMs}ms`).padEnd(10) +
    (r.worstMs === null ? '—' : `${r.worstMs}ms`).padEnd(10) +
    `${r.dialMin}-${r.dialMax}`.padEnd(8) +
    r.role
  )
  for (const note of r.notes) console.log(' '.repeat(31) + `↳ ${note}`)
}

// RANKING: delivery reliability first, then median latency. Delivery is ranked first and absolutely,
// not weighted — a relay that drops 1 wrap in 3 is not "a bit worse" than one that drops none, it is
// a source of false success signals (publishGiftWrap treats OK as success). Latency only breaks ties
// among relays that delivered everything.
const ranked = [...results].sort((a, b) =>
  (b.delivers - a.delivers) ||
  ((a.medianMs ?? Infinity) - (b.medianMs ?? Infinity)) ||
  (a.dialMax - b.dialMax)
)

const perfect = ranked.filter(r => r.delivers === n)
console.log(`\n  MEETS THE BAR (accepts AND delivers ${n}/${n}):`)
if (!perfect.length) console.log('    NONE')
for (const [i, r] of perfect.entries()) {
  console.log(`    ${i + 1}. ${r.url.padEnd(32)} median ${String(r.medianMs).padStart(5)}ms   worst ${String(r.worstMs).padStart(5)}ms   dials ${r.dialMin}-${r.dialMax}   ${r.role}`)
}

// DISQUALIFYING vs MERELY FLAKY — the distinction the ranking above cannot express.
const liars = ranked.filter(r => r.droppedAfterAccept > 0)
if (liars.length) {
  console.log(`\n  🔴 ACCEPTS THEN DROPS — DISQUALIFYING, do not put in DEFAULT_RELAYS:`)
  console.log(`     An OK is recorded as success by publishGiftWrap, so the sender is told it landed`)
  console.log(`     and the recipient gets nothing. Worse than a relay that is simply down.`)
  for (const r of liars) console.log(`     ${r.url.padEnd(32)} dropped after accepting in ${r.droppedAfterAccept}/${n} rounds`)
}

const flaky = ranked.filter(r => r.noConnect > 0 && r.droppedAfterAccept === 0 && r.delivers > 0)
if (flaky.length) {
  console.log(`\n  🟡 FLAKY DIAL ONLY — not disqualifying: delivered everything it accepted.`)
  console.log(`     This is the documented ~30% cold-dial failure, which the publish retry compensates.`)
  for (const r of flaky) console.log(`     ${r.url.padEnd(32)} failed to connect in ${r.noConnect}/${n} rounds, delivered ${r.delivers}/${r.connects} of those it reached`)
}

const refused = ranked.filter(r => r.rejected > 0)
if (refused.length) {
  console.log(`\n  ⛔ REFUSES kind 1059 — unusable for NIP-17, but at least it is HONEST about it:`)
  for (const r of refused) console.log(`     ${r.url.padEnd(32)} ${r.notes[0] ?? ''}`)
}

const dead = ranked.filter(r => r.connects === 0)
if (dead.length) {
  console.log(`\n  ☠ UNREACHABLE (${CONNECT_ATTEMPTS} dials × ${n} rounds, all failed):`)
  for (const r of dead) console.log(`     ${r.url}`)
}

console.log(`\n  Suggested best ${Math.min(5, perfect.length)} by delivery-then-latency:`)
console.log(`    ${perfect.slice(0, 5).map(r => r.url).join('\n    ') || 'insufficient passing relays'}`)
console.log()
process.exit(0)
