# Caravel Known Issues

Confirmed defects that are diagnosed but not yet fixed, with enough detail that the fix does not
need the investigation repeated. Each entry records where the bug lives, how it was proven, and what
was ruled out — the ruled-out list matters as much as the cause, because it is what stops the next
person re-testing the same dead ends.

---

## 1. Group messages intermittently reach only a subset of members

**Status:** diagnosed, not fixed · **Severity:** high — silent message loss
**Affects:** `main` and every branch (**pre-existing; not introduced by any feature branch**)
**Fix belongs on:** its own branch off `main`. Candidate to ship to production *ahead of* the
in-flight feature branches, since it degrades the core messaging guarantee.
**Diagnosed:** 2026-08-17, against `wss://relay.damus.io` + `wss://relay.primal.net`
(the two entries in `src/config/relays.ts`).

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

Related, lower-priority observation from the same run: several wraps were accepted (`OK`) but **not
served back** on a later query. Harmless for a live subscriber (the event is pushed at publish time)
but it makes the ~2-day backfill-on-unlock less dependable than the accept count implies. Could be
indexing lag rather than loss; not distinguished.

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

### Recommended fix

1. **Publish over the provider's existing live sockets** instead of dialling throwaway ones. The
   provider already keeps both relays connected and heartbeat-verified; using them removes the
   dominant failure mode rather than compensating for it. This alone is expected to make (2)
   largely unnecessary.
2. *(secondary)* Retry a failed publish per relay, and treat "accepted by every relay" as the goal
   rather than "at least one".
3. **Make `membersReached` honest** — report per-relay coverage so a wrap that landed on only one
   relay is visible to the sender rather than counted as full success.

Adding more relays would improve the odds statistically but treats the symptom, not the cause.

### Where to look

| Concern | File |
|---|---|
| Publish path, fresh-socket dialling, first-accept | `src/crypto/nostrMessaging.ts` → `publishGiftWrap` |
| Group fan-out, `membersReached`, the unused live sockets | `src/messaging/NostrMessagingProvider.ts` → `sendGroupMessage`, `records[].relay` |
| Control-message retry (the pattern ordinary messages lack) | `src/messaging/NostrMessagingProvider.ts` → `publishControl` |
| Relay list | `src/config/relays.ts` |
| Per-wallet **subscribe** reach, live in the UI | `src/components/chat/ConnectionStatus.tsx` → `RelayHealthPanel` |

The relay-health panel already serves as a per-wallet reach map for *reads*: open it in each browser
and the member that misses should be the one whose failed relay is where the sender's wrap landed.
It shows nothing about *publish* reach, because publishes use throwaway sockets that never appear in
`records` — which is itself the finding.
