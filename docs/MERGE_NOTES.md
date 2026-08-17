# Merge notes — edit-messages ↔ image-attachments

**Why this file exists:** resolving these two feature branches together surfaced fixes that are
**genuine integration work, not merge mechanics** — and the two below **will not surface as
conflicts**, because neither lives in a conflict hunk. Both files auto-merge "cleanly" into code that
is wrong.

Anyone constructing this merge: **work through the checklist below by hand.** Git will not prompt
you.

*Provenance: written while resolving the same two branches on the disposable `integration-test`
branch, so every item below was hit for real, not anticipated. Edited for the production merge — the
relay finding it used to carry is obsolete (primal is already out of production `main` as of
`67ac909`) and has been removed.*

---

## Carry over — required in the real prod merge

### 1. `beginEdit` must stop calling `setSendError`

**Where:** `src/components/chat/ChatApp.tsx`, inside `beginEdit`.

edit-messages' `beginEdit` ends with:
```ts
setDraft(currentText)
setSendError(null)      // ← DELETE THIS LINE
composerRef.current?.focus()
```

`sendError` was **write-only state** — commit `a223484` (thread redesign) removed the JSX that
rendered it and left the state and every setter call behind. The image work deleted it outright in
`6ab36f7`, once the provisional-bubble failure surface replaced it.

So after the merge that call references a variable that no longer exists.

- **Symptom if missed:** `tsc` → `TS2304: Cannot find name 'setSendError'`.
- **Was it in a conflict hunk?** **No.** Both sides auto-merged; the error only appears at typecheck.
- **Risk level:** low — it fails loudly. Recorded because *finding* it cost a typecheck-and-trace
  cycle, and because the fix is "delete", which looks wrong until you know `sendError` is dead.
- **Nothing is lost by deleting it:** it was clearing state nobody rendered.

### 2. `|| attachment` exclusivity guard in `beginEdit`, in BOTH composers

**Where:** `src/components/chat/ChatApp.tsx` and `src/components/chat/GroupThread.tsx`, both
`beginEdit` functions.

```ts
// ChatApp
if (paymentMode || confirming || sending || payBusy || attachment) return
//                                                     ^^^^^^^^^^ add
// GroupThread
if (sending || attachment) return
//             ^^^^^^^^^^ add
```

**Why:** edit mode uses the composer's textarea as the **edit field**; attach mode uses the same
textarea as the image's **caption field**. Both bind `draft`. `beginEdit` already refuses the other
composer states for precisely this reason — but neither branch knew the other's state existed, so
neither listed it.

- **Symptom if missed:** pick an image, then click a message's edit pencil. Both states are active,
  the caption text and the edit text overwrite each other in `draft`, and Save/Send act on whichever
  won. **Silent — nothing throws, nothing fails to compile, no test catches it.**
- **Was it in a conflict hunk?** **No.** Each `beginEdit` came wholesale from edit-messages and each
  `attachment` state came wholesale from image-attachments. Git had no overlap to report.
- **Risk level:** HIGH for a silent regression. This is the one to actually verify by hand after the
  real merge: attach an image, then try to start an edit — the pencil must do nothing.

---

## `wrapMessage` — RESOLVED on main; here is the conversion rule

**This is no longer a hazard, but it changes what a correct resolution looks like.**

The collision was that both branches added a **7th positional parameter** to `wrapMessage` — a
competing position, not a competing name:

```ts
// edit-messages          …, groupId?: string, logicalId?: string
// image-attachments      …, groupId?: string, media?: MediaRef
```

Main resolved this ahead of the merge in `9d46b10` by converting the optional tail to a named
options object:

```ts
export interface WrapMessageOptions { payment?, tariAddress?, groupId? }
wrapMessage(sk, pk, plaintext, opts: WrapMessageOptions = {})
```

**So the rule for this merge:** each branch contributes a **KEY**, not a position.

- Add `logicalId?: string` and `media?: MediaRef` to `WrapMessageOptions` — a **union of keys**.
- Add each branch's `if (…) tags.push(…)` guard in `wrapMessage` — again a union, order irrelevant
  to readers (they match on `tag[0]`).
- **Every call site converts to key form.** Both branches' calls are still positional and will look
  like `wrapMessage(sk, pk, text, undefined, undefined, groupId, logicalId)`. That shape no longer
  compiles. It becomes `wrapMessage(sk, pk, text, { groupId, logicalId })`.

Conflicts in these regions are still *likely* — both branches edit the same lines. What changed is
that a conflict is now **trivially and verifiably resolvable as a union**, and a wrong resolution
fails loudly (unknown key, or a missing key that shows as the feature being off) instead of silently
binding a value to the wrong meaning. Under the old positional signature `tariAddress`, `groupId` and
`logicalId` were **all `string`**, so a transposition was invisible to `tsc`.

**Call-site volume:** 3 production sites per branch (all in `NostrMessagingProvider.ts`) plus
**12 test call sites per branch** — the test file is the bulk of the mechanical work.

### The cross-feature rules git DOES surface

These *were* real conflicts, so the merge will surface them again and they need no checklist — listed
only so nobody re-derives them:

- `!m.media` in `canEditMessage` (`messageEdit.ts`) — an image row is not editable, because editing
  replaces `plaintext`, which on a media row is only the caption.
- `if (m.media) return <MediaMessageCard/>` before the editable branch in **both** threads' render
  dispatch — the structural half of the same guard.

---

## Recurring: `nostrMessaging.test.ts` add/add — expect it, concatenate it

**Both feature branches independently created `src/crypto/nostrMessaging.test.ts`.** It is the
natural name for that module's tests, and several people extended the same module — so this is
structural, not bad luck. It collided as an add/add in **both** merges on `integration-test`.

**Every suite must survive. Taking a side silently deletes a milestone's coverage and nothing fails
to warn you.**

| Source | `describe` blocks | Tests |
|---|---|---|
| **`main` (base, already present)** | `planPublishRetry`, `wrapMessage — options object` | **21** |
| `edit-messages` | `newLogicalId`, `caravel-msgid on the wire`, `caravel-edit on the wire` | 9 |
| `image-attachments` | `caravel-media on the wire`, `caravel-media — malformed refs degrade…`, `existing wire behaviour is unchanged` | 16 |
| **expected merged total** | **8 blocks** | **46** |

Note main is no longer an empty base for this file: it already carries 21 tests, so this is a
**three-way** concatenation, and the two branches' contributions must be added *without* disturbing
what is already there.

Concatenating is mechanical but not zero-thought — three things need doing by hand:

1. **Merge the import lines into one.** Each side imports a different subset from
   `./nostrMessaging`; the union is
   `{ newLogicalId, planPublishRetry, unwrapMessage, wrapEdit, wrapMessage }`.
2. **Convert every incoming `wrapMessage` call to key form** (see the section above). The branches'
   24 combined test calls are all positional and will not compile as-is.
3. **Check for fixture name collisions.** They were disjoint on `integration-test` —
   edit-messages used `alice`/`bob`/`bobPub`/`wrapRawTags`, image-attachments used
   `senderSk`/`recipientSk`/`senderPk`/`recipientPk`/`ref`/`roundTrip`, and the relay suite used
   `MAX`/`BASE`/`CONNECT`/`BUDGET`/`plan`. **Do not assume that still holds** — main's own
   `wrapMessage` suite now adds `sender`/`recipient`/`recipientPub`/`roundTrip`, which **already
   collides with image-attachments' `roundTrip`**. A duplicate `const` is at least a compile error,
   but a duplicated *helper function* with different behaviour would not be.

The same applies to `package.json`: both branches added `"test": "vitest run"` identically (so it
auto-merges), but `image-attachments` alone added `"test:live"` — keep it. And never hand-merge
`package-lock.json`; take either side and re-run `npm install`.

---

## Merge mechanics worth knowing (cost two bugs here)

**The identical-suffix trap.** When both sides of a conflict end with the *same* closing syntax, git
hoists that suffix **out** of the conflict and places it once *after* the `>>>>>>>` marker. A naive
"keep HEAD, then keep theirs" concatenation then lets that single closer terminate the **second**
block, orphaning the first. It fired twice:

- `nostrMessaging.ts` — `extractEdit` and `extractMedia` both end `}` / `return undefined` / `}`.
  The shared tail closed `extractMedia`; `extractEdit` lost its closing braces entirely.
- `ChatApp.tsx` — the editing banner and the attach preview both end `)}`. The shared closer
  terminated the attach block; the editing banner was left unclosed.

Both surfaced as syntax errors *only because braces are checkable*. **A balanced shared suffix — a
`return`, a field, a closing paren inside an expression — would compile while silently dropping
behaviour.** The tell is a closer sitting after the `>>>>>>>` marker: check for it before
concatenating, and read every resolved function end-to-end rather than trusting marker-freeness.

`GroupThread.tsx` was audited hunk-by-hunk for this and was clean — both its composer panels carried
their own `)}` *inside* the conflict, so there was nothing to hoist.

---

## Verification bar

Reached on `integration-test` with the same two features (different base — that base had no
`wrapMessage` suite and a different relay set):

```
tsc -p tsconfig.app.json  → 0
npm test                  → 8 files, 203 tests
npx vite build            → clean
conflict markers in src/  → none
```

For **this** merge the equivalent bar is the above plus:

- `nostrMessaging.test.ts` → **46 tests in 8 describe blocks** (21 base + 9 + 16)
- **zero positional `wrapMessage` calls remain** — every call is key form
- `beginEdit` in both composers refuses when `attachment` is set (item 2 — verify by hand, no test
  covers it)
