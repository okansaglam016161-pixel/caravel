# Caravel Known Issues

Confirmed defects, with enough detail that the fix does not need the investigation repeated. Each
entry records where the bug lives, how it was proven, and what was ruled out — the ruled-out list
matters as much as the cause, because it is what stops the next person re-testing the same dead ends.

Entries are kept after they are fixed, marked with what shipped. A diagnosis is worth more than the
patch: it is what tells the next person whether a recurrence is the same bug returning or a new one
wearing its symptoms.

**Current state at a glance**

| | |
|---|---|
| `DEFAULT_RELAYS` | 5 relays — `relay.snort.social`, `nos.lol`, `relay.nostr.net`, `nostr.mom`, `relay.damus.io`. **`relay.primal.net` removed.** |
| Publish retry | **Shipped** — `PUBLISH_ATTEMPTS = 3`, bounded, jittered, budget-clamped (`crypto/nostrMessaging.ts`) |
| Issue 1 (partial delivery) | **Largely addressed**, one recommendation outstanding |
| Issue 2 (primal accept-then-drop) | **Fixed by removal** |
| Still outstanding | **`membersReached` counts relay ACCEPTANCE, not delivery** — see issue 1, rec. 3 |

---

## 1. Group messages intermittently reach only a subset of members

**Status:** **largely addressed** — see "What shipped" below. One recommendation outstanding.
**Severity:** was high — silent message loss
**Affected:** `main` and every branch (**pre-existing; not introduced by any feature branch**)
**Diagnosed:** 2026-08-17, against `wss://relay.damus.io` + `wss://relay.primal.net` — the two
entries `src/config/relays.ts` held *at the time*. **That is no longer the relay set**; everything
below describing a two-relay list is the historical diagnosis, retained because the reasoning still
explains the failure mode.

### What shipped (commit `67ac909`)

1. **`relay.primal.net` removed** from `DEFAULT_RELAYS` — issue 2 below, and the single biggest
   contributor.
2. **The relay set widened to five**, each held to a real accept-AND-deliver round trip:
   `relay.snort.social`, `nos.lol`, `relay.nostr.net`, `nostr.mom`, `relay.damus.io`. Since relays do
   not federate, more verified relays directly raises the odds that sender and recipient overlap on
   one — which is the mechanism this bug turns on.
3. **A bounded per-relay publish retry** (`PUBLISH_ATTEMPTS = 3`, jittered backoff, clamped so a retry
   can never exceed the caller's latency budget). This is recommendation 2 below, and it covers the
   ~30% cold-dial failure that ordinary messages previously had no protection against.

**Still outstanding: recommendation 3 — `membersReached` remains a count of relay ACCEPTANCE, not
delivery.** Recommendation 1 (publishing over the provider's live sockets) was not done either; the
retry plus a healthier relay set was judged sufficient without restructuring the send path.

### Symptoms

- A group message or image reaches **some** members and not others.
- **Intermittent and self-healing**: the same group works, then misses a member, then works again,
  with no code change in between.
- **Asymmetric**: a send from wallet A reaches B but not C, while a send from C reaches both.
  Different sends miss different members.
- **DMs between the same wallets are reliable**, which is what makes it look like a group bug.
- The sender is often given **no indication** that anyone missed it.

### Root cause

**Every publish dials a brand-new WebSocket, and dialling these relays fails roughly 30% of the
time.** The failure is not retried for ordinary messages.

Measured directly (8 connect attempts per relay, fresh socket each time):

```
damus.io     sequential 5/8 ok    concurrent 7/8 ok
primal.net   sequential 5/8 ok    concurrent 6/8 ok
```

`publishGiftWrap` (`src/crypto/nostrMessaging.ts`) creates `new Relay(url)` per attempt, per event.
Meanwhile `NostrMessagingProvider` **already holds live, heartbeat-monitored connections to both
relays** in `records[].relay` — and the publish path ignores them completely. So the app maintains
good sockets for reading and throws away sockets for writing.

Two further facts turn a flaky dial into silent loss:

1. **Relays do not federate.** Verified: an event published to `damus.io` was served back by
   `damus.io` and was **invisible** on `primal.net`. A wrap that lands on one relay is deliverable
   only to members currently live on *that* relay.
2. **Ordinary messages are never retried.** `publishControl`'s bounded retry applies only to control
   messages (group definitions, leave notices, re-invites). `sendMessage` and `sendGroupMessage` get
   one attempt per relay and no more.

**Subscriptions suffer the same ~30% dial failure**, but they *recover* — `scheduleReconnect` plus
the heartbeat probe bring them back. That asymmetry (reads self-heal, writes don't) is exactly why
the bug appears to come and go on its own.

A miss therefore happens when both of these coincide:

- the wrap was accepted by **only one** relay (about half of all wraps — see below), and
- that member's subscription to **that** relay is momentarily down.

### Reproduced outside the app

Three simulated members, each live-subscribed to both relays as the app does, then one
group-shaped burst of three wraps:

```
member 0
   publish                   : damus.io:FAIL   primal.net:FAIL
   membersReached would count: false
   DELIVERED live via        : *** NOTHING - MEMBER MISSED ***
member 1
   publish                   : damus.io:ok     primal.net:FAIL
   DELIVERED live via        : damus.io
member 2
   publish                   : damus.io:ok     primal.net:ok
   DELIVERED live via        : damus.io, primal.net

1 of 3 members received nothing.
```

In the same run one member also **failed to subscribe** to `damus.io`, demonstrating the read-side
half of the same dial failure.

The wrap **is** built for every member and a publish **is** attempted — so this is not a fan-out or
roster bug. It is `wrapped + attempted + no relay accepted`.

### Why DMs survive and groups do not

With per-dial success ≈ 0.7:

| | dials | outcome |
|---|---|---|
| **DM** | 1 wrap × 2 relays | P(no relay accepts) ≈ 0.09, and the peer is usually live on both → feels "always fine" |
| **Group** | N *independent* wraps | each lands on **both** relays only ≈ 0.49 of the time, so **~half of wraps land on a single relay** |

P(every member receives) falls off geometrically with roster size. A DM needs **one** overlap
between sender and peer; a group needs **N** independent overlaps, each with a coin-flip chance of
having only one relay to overlap on. Same relays, same wallets, same code — only the number of
required overlaps differs.

### `membersReached` reports false success

```ts
if (results.some(r => r.ok)) membersReached++   // ≥1 relay ACCEPTED
```

It counts **relay acceptance**, not delivery, so it is blind to the cases that actually cause the
symptom:

| Case | `membersReached` | Member receives it? |
|---|---|---|
| No relay accepted | ✅ counted as a miss | no |
| Accepted by one relay; member's subscription to that relay is down | ❌ **counted as reached** | **no** |
| Accepted but not served, and the member was offline | ❌ **counted as reached** | **no** |

Hence "reached 2 of 2" alongside a member who never got the message.

Related observation from the same run: several wraps were accepted (`OK`) but **not served back** on a
later query. At the time this was filed as low-priority and possibly indexing lag.

> **⚠ SUPERSEDED — see issue #2 below.** It is not lag. `relay.primal.net` accepts gift wraps and then
> fails to deliver them to a *live subscriber* roughly two times in three. That makes accept-without-
> delivery a **primary** cause of this bug rather than a footnote, and it is arguably a bigger
> contributor than the cold-dial churn described above.

### Ruled out — do not re-investigate

- **Roster corruption from group lifecycle churn.** A brand-new group with zero leave/re-invite
  history still drops members.
- **The image-attachments work.** `03fa605` (first-accept) is an ancestor of `main`, and the image
  branch's diff to `nostrMessaging.ts` contains **no** publish/relay changes; every
  `NostrMessagingProvider.ts` change is an additive `media?` parameter or a destructure. The fan-out
  loop, `Promise.all`, `publishGiftWrap`, the relay list and the subscription filter are identical
  to `main`.
- **Resolve-on-first-accept withholding the second publish** (`03fa605`). It does not:
  `relayUrls.map(...)` starts an attempt on *every* relay immediately; first-accept only stops the
  caller *waiting*, and the remaining attempt continues in the background and closes its own socket.
- **Rate limiting or connection limits under burst.** Measured above — concurrent connects performed
  *better* than sequential ones, so the failure rate is load-independent.
- **The fan-out or the roster.** A wrap is built and a publish attempted for every member.

### Recommended fix — and what became of each

1. ☐ **Publish over the provider's existing live sockets** instead of dialling throwaway ones. The
   provider already keeps every relay connected and heartbeat-verified; using them would remove the
   dominant failure mode rather than compensating for it. **NOT DONE.** It couples publish failures to
   the subscription socket and requires routing sends through the live provider instead of the
   throwaway one every call site builds today. The retry in (2) made it unnecessary for now, not wrong.
2. ☑ **Retry a failed publish per relay.** **SHIPPED** (`67ac909`) — `PUBLISH_ATTEMPTS = 3`, jittered,
   budget-clamped. Note the second half of the original recommendation — treating "accepted by every
   relay" as the goal rather than "at least one" — was **not** adopted; the success test is still
   `results.some(r => r.ok)`, which is what keeps (3) open.
3. ☐ **Make `membersReached` honest** — report per-relay coverage so a wrap that landed on only one
   relay is visible to the sender rather than counted as full success. **STILL OUTSTANDING, and it is
   now the main open item.** With primal gone and five verified relays the false-success rate should
   be far lower, but the signal is still structurally wrong: it reports acceptance and calls it reach.

The original note here read "adding more relays would improve the odds statistically but treats the
symptom, not the cause." That was written when the cause was believed to be cold-dial churn. It is
half-wrong: since relays do not federate, overlap between sender and recipient IS the mechanism, so a
wider VERIFIED set is a real fix rather than a palliative — which is why five shipped. The caution
still holds for adding relays *without* holding them to the accept-and-deliver bar; primal is exactly
what that gets you.

### Where to look

| Concern | File |
|---|---|
| Publish path, fresh-socket dialling, first-accept | `src/crypto/nostrMessaging.ts` → `publishGiftWrap` |
| Group fan-out, `membersReached`, the unused live sockets | `src/messaging/NostrMessagingProvider.ts` → `sendGroupMessage`, `records[].relay` |
| Control-message retry (the pattern ordinary messages lack) | `src/messaging/NostrMessagingProvider.ts` → `publishControl` |
| Relay list (now 5, verified) | `src/config/relays.ts` |
| The accept-AND-deliver gate | `scripts/relay-verify.mjs` — run before changing the relay list |
| Publish retry policy (pure, tested) | `src/crypto/nostrMessaging.ts` → `planPublishRetry` |
| Per-wallet **subscribe** reach, live in the UI | `src/components/chat/ConnectionStatus.tsx` → `RelayHealthPanel` |

The relay-health panel already serves as a per-wallet reach map for *reads*: open it in each browser
and the member that misses should be the one whose failed relay is where the sender's wrap landed.
It shows nothing about *publish* reach, because publishes use throwaway sockets that never appear in
`records` — which is itself the finding.

---

## 2. `relay.primal.net` accepts kind-1059 gift wraps and then fails to deliver them

**Status:** **FIXED by removal** (commit `67ac909`) · **Severity:** was high — **silent** message
loss with a false success signal
**Affected:** production `main`, where `relay.primal.net` was one of only two entries in
`DEFAULT_RELAYS`. Not caused by any branch.
**Measured:** 2026-08-17, `scripts/relay-verify.mjs`, 3 rounds. **Re-measured before removal: it had
not recovered but REGRESSED** — 0/3 delivery plus 2/3 connect failures.

Retained after the fix because the FAILURE MODE is the durable lesson, not the specific host: any
relay can start accepting and not delivering, and the app's only success signal cannot detect it.
`node scripts/relay-verify.mjs` is the gate that catches it.

### What it does

It accepts the event — returns `OK` — and then does not serve it to a subscriber. On the one round in
three where delivery did happen, it took **7.2 seconds**.

| relay | connects | accepts 1059 | delivers 1059 | median latency |
|---|---|---|---|---|
| `nos.lol` | 3/3, 1 dial each | 3/3 | **3/3** | ~176ms |
| `relay.snort.social` | 3/3, 1 dial each | 3/3 | **3/3** | ~130ms |
| `relay.damus.io` | 3/3, 2–4 dials | 3/3 | **3/3** | ~466ms |
| **`relay.primal.net`** | 3/3, 1–2 dials | 3/3 | **1/3 ⚠** | 7236ms on its one success |
| `relay.nostr.band` | **0/3**, 0/12 dials | — | — | unreachable |

### Why this is worse than a relay simply being down

**A dead relay is safe; this one lies.** `publishGiftWrap` treats an `OK` as success, so:

- `results.some(r => r.ok)` is true → `membersReached` counts that member as **reached**
- the sender's UI reports success, and the group composer shows no shortfall
- the recipient receives **nothing**

So the one signal the app has for "did this land" is actively wrong. A relay that refused the event
would at least be counted as a miss. This is the mechanism behind "shows sent but never arrives", and
it needs no coincidence of timing or subscription state — unlike the cold-dial explanation, which
requires the wrap to land on only one relay *and* the recipient to be down on that relay.

**It also poisons the two-relay case specifically.** On `main` the list is damus + primal. Any wrap
that damus's ~30% cold-dial failure loses, primal then accepts-and-drops ~2/3 of the time. Two relays,
one of which is functionally write-only.

### How it was measured — and a trap to avoid repeating

`scripts/relay-verify.mjs` publishes a real kind-1059 wrap on one connection and reads it back on a
**second** connection, because a single socket can appear to work when the relay merely echoes your own
publish back to you. Throwaway keypair, no app state.

**The first version of that script reported total failure for BOTH proven controls** (damus and
primal) — a false negative from single-attempt connects against the ~30% cold-dial failure rate. It now
retries the connect up to 4 times. **A capability test must retry the transport before drawing any
conclusion about the protocol**, or it measures dial luck and calls it relay behaviour.

### Carry forward to the real production relay decision

- **Drop `relay.primal.net` from production `DEFAULT_RELAYS`.** It is not a marginal performer, it is a
  source of false success signals. `nos.lol` and `relay.snort.social` both beat it on connect cost,
  latency and delivery, so there is no capacity argument for keeping it.
- **Add `nos.lol` and `relay.snort.social`.** Both verified accept+deliver 3/3 with single-dial
  connects and lower latency than damus. They clear the M7.2 bar that damus and primal were held to.
- **Do not add `relay.nostr.band`.** Unreachable — 12 connect attempts, all timed out.
- **Re-verify before shipping.** These are third-party services; a relay that passes today can regress.
  `node scripts/relay-verify.mjs` is the gate, and it takes about a minute.
- **Make `membersReached` honest regardless** (issue #1's recommendation 3). Even with good relays,
  accept ≠ delivery, and the count should not claim otherwise. **Still outstanding.**

### What was actually shipped

All of the above except the last, in `67ac909`. The final set is five relays, not three — the
candidate sweep was widened after this was written, and `relay.nostr.net` and `nostr.mom` both cleared
the same accept-and-deliver bar:

```
relay.snort.social   3/3 deliver    73ms
nos.lol              3/3 deliver   166ms
relay.nostr.net      3/3 deliver   192ms
nostr.mom            3/3 deliver   234ms
relay.damus.io       2/3 deliver   299ms   ← kept: its miss was a failed DIAL, which the
                                             publish retry covers, and it is the most populated
                                             relay, so it buys the most sender/recipient overlap
```

`relay.nostr.wirednet.jp` also scored 2/3 and was REJECTED, because its miss was accept-then-drop —
the same pathology as primal, which no retry can fix. **Two relays with an identical score needed
opposite decisions; the failure CLASS is what matters, not the count.**
