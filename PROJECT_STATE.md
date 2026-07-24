# Caravel — Project State (2026-07-22)

Source of truth for a fresh session. Read the code, don't trust memory.

---

## 1. Repo Structure

### 1a. `~/Desktop/caravel-app` — the app

```
caravel-app/
├── index.html                          Entry point (mounts #root)
├── vite.config.ts                      Build config — WASM plugin, tari.js aliases
├── tsconfig.app.json                   TS config — strict, bundler mode, tari.js paths
├── tsconfig.json / tsconfig.node.json  TS project references
├── package.json                        Dependencies (see §5)
├── package-lock.json
├── .gitignore                          Excludes: .env, node_modules, dist, tarijs-reference, *.log
├── .oxlintrc.json                      Linter config
├── tari-project-indexer-client-1.4.2.tgz  Bundled .tgz; installed but NOT imported anywhere
├── public/
│   ├── favicon.svg
│   └── icons.svg
└── src/
    ├── main.tsx                        React root — StrictMode wrapper
    ├── App.tsx                         Router: / → LandingPage, /app → AppRoute
    ├── App.css                         Global CSS vars (--acc, --accRGB, etc.)
    ├── index.css                       Body reset, font imports (IBM Plex Mono from Google)
    ├── assets/
    │   ├── hero.png                    Unused asset
    │   ├── react.svg                   Unused scaffold asset
    │   └── vite.svg                    Unused scaffold asset
    ├── context/
    │   └── WalletContext.tsx           React context: wallet state, scan, txHistory, recordSent
    ├── crypto/
    │   ├── walletCrypto.ts             BIP-39 generation, PBKDF2-AES-GCM storage, key derivation
    │   ├── walletScanner.ts            UTXO blind scan, decryptOwnedUtxo, memo decode
    │   ├── confidentialSend.ts         Full confidential stealth send (browser port of Node script)
    │   └── txHistory.ts               LocalStorage-persisted tx history, merge/add helpers
    └── components/
        ├── Logo.tsx                    SVG logo component
        ├── AppRoute.tsx                Route guard: no wallet→Create, locked→Unlock, open→Chat
        ├── landing/
        │   └── LandingPage.tsx         Marketing page (fully static)
        ├── chat/
        │   └── ChatApp.tsx             Chat shell (mostly static mock — see §3)
        └── wallet/
            ├── CreateWallet.tsx        Multi-step wallet creation flow (fully working)
            ├── UnlockWallet.tsx        Password unlock + phrase restore (fully working)
            ├── WalletModal.tsx         Centered overlay modal — 4 tabs + Settings (primary wallet UI)
            ├── WalletPanel.tsx         OLD sidebar drawer — ORPHANED, not used, safe to delete
            └── DecryptPanel.tsx        Dev tool: paste UTXO ID → decrypt amount + memo
```

**Gitignored in caravel-app:** `.env`, `.env.*`, `*.token`, `*.key`, `secrets/`, `node_modules/`, `dist/`, `build/`, `.vite/`, `tarijs-reference/`, `.DS_Store`, `*.log`, `.vscode/`, `.idea/`

---

### 1b. `~/Desktop/caravel` — research repo

```
caravel/
├── .gitignore                     Excludes: .env, *.token, *.key, node_modules, tarijs-reference
├── .env                           ⚠️ GITIGNORED — contains TARI_API_KEY (see §7)
├── RECIPE.md                      Knowledge base — 17 sections (see §1c)
├── tari_test.sh                   Bash script: wallet-daemon JSON-RPC calls via curl; reads .env for key
├── wallet-b.json                  ⚠️ UNTRACKED — real key material (see §7)
├── .claude/
│   └── skills/ootle/SKILL.md      Claude Code skill file (see §1d)
└── tarijs-reference/              The tari.js monorepo (gitignored here)
    ├── packages/
    │   ├── ootle/                 Core SDK (version 0.1.0) — pre-built dist used by caravel-app
    │   ├── ootle-indexer/         Indexer provider (version 0.1.0) — pre-built dist used by caravel-app
    │   ├── ootle-secret-key-wallet/ Browser secret-key wallet (version 0.1.0) — pre-built dist
    │   └── ootle-wallet-daemon-signer/ Daemon signer (not used in caravel-app)
    └── examples/
        └── node/src/stealth/
            └── confidential-send.ts  SOURCE OF TRUTH for send logic (proven tx 836369ed…)
```

**Gitignored in caravel:** `.env`, `*.token`, `*.key`, `secrets/`, `node_modules/`, `dist/`, `build/`, `tarijs-reference/`, `.DS_Store`

---

### 1c. `RECIPE.md` section headings

1. Auth
2. accounts.list
3. accounts.get_balances
4. accounts.stealth_transfer
5. stealth_utxos.list
6. PayRefAndBytes encoding
7. tari.js SDK — Esmeralda version alignment
8. Stealth transfer to a bare keypair address
9. Browser-side UTXO discovery (Path A: known tx ID; Path B: blind scan)
10. Browser-side memo decoding
11. Indexer CORS
12. tari.js stealth-wallet example — key persistence
13. Observed fees
14. Confidential fee payment — how it actually works (includes two-UTXO investigation, tari.js gap finding, reference impl)
15. Gotchas
16. M4: BROWSER SENDING — ~~status and blockers~~ RESOLVED (struck through, resolved)
17. Single-UTXO Confidential Send — Proven Architecture (the winning approach; tx hash, fee breakdown, exact tari.js call sequence, `__tla` ordering gotcha)

---

### 1d. `SKILL.md` summary

`~/Desktop/caravel/.claude/skills/ootle/SKILL.md` — A large Claude Code skill covering Tari Ootle development. Sections include: Ootle crate ecosystem, templates (Rust/WASM smart contracts), components, resources, vaults, buckets, transactions, `TransactionBuilder` API, how to submit/watch transactions, stealth (confidential) payments, the UTXO scan pattern, memo encoding, `IndexerProvider`, `SecretKeyWallet`, and gotchas specific to the `__tla` top-level-await initialization ordering in Vite.

---

## 2. Git History

### caravel-app (`git log --oneline`)

```
6b2fdc6 Complete wallet: real Activity history + scannable QR receive
c5a4730 Wallet modal with working confidential send + receive, auto-refresh
425fb47 Automatic confidential receiving: UTXO scan, real balance in wallet panel + sidebar with toggle
16690cf Persistent self-custodial wallet: CipherSeed 24-word, encrypted storage, unlock + restore, address display
03ecc4b Link patched tari.js; verified in-app esmeralda wallet generation
60f4659 Caravel skeleton: full-viewport landing + chat with routing
e157ca2 Initial commit: gitignore
```

**Commit message mismatches:**

- `16690cf` — says "CipherSeed 24-word". The code is **standard BIP-39** using `@scure/bip39`. Tari's CipherSeed format (which encodes birthday, network, checksum) is not used anywhere. The mnemonic is a plain 24-word BIP-39 phrase with a custom key derivation on top.
- `03ecc4b` — says "Link patched tari.js". The word "patched" is a bit misleading: it's not a fork/patch of tari.js. The setup uses the pre-built dist from `tarijs-reference` (a local clone of the official SDK monorepo) via Vite aliases. `SdkTest.tsx` (a throwaway component added in this commit) was removed by `16690cf` without mention. The `.tgz` file (`tari-project-indexer-client-1.4.2.tgz`) was committed in `16690cf` but is never imported anywhere — its purpose is unclear.

**Git status — caravel-app:** Clean. Branch `main` is up to date with `origin/main` (remote: GitHub). Nothing uncommitted, nothing unpushed.

**Git status — caravel research repo:** `RECIPE.md` is modified (uncommitted). `wallet-b.json` is untracked. No remote configured.

### caravel research repo (`git log --oneline`)

```
de08ce5 Document confidential fee mechanism and tari.js gap (M4 spec)
078e6d8 Milestone 3: browser decrypts externally-sent confidential payment with memo
8629038 Add RECIPE.md documenting working wallet JSON-RPC calls
685f2ab Milestone 2: confidential tTARI transfer with encrypted memo + pay_ref via wallet JSON-RPC
```

No message mismatches found. All commits match their diffs accurately.

---

## 3. The App — What's Actually Built

### Routes

| Route | Component | State |
|-------|-----------|-------|
| `/` | `LandingPage` | **Fully working** as a static marketing page. Nav links ("How it works", "Privacy") and the secondary CTA button are visual-only — no `onClick` handlers. |
| `/app` | `AppRoute` → gate | **Fully working** — correctly routes to Create / Unlock / ChatApp based on wallet state. |

### Wallet Create/Unlock Flow

| Screen | Component | State |
|--------|-----------|-------|
| Create wallet | `CreateWallet.tsx` | **Fully working.** Multi-step: generates 24-word BIP-39 phrase, shows words, verify-3-words quiz, password setup, creates encrypted wallet in localStorage. |
| Unlock | `UnlockWallet.tsx` | **Fully working.** Two modes: password unlock and phrase restore (all 24 words + new password). Correct error handling for wrong password (AES-GCM OperationError). |

### Chat App (`ChatApp.tsx`)

The chat shell is a **static visual mock**. Nothing in it is real or interactive:

- Conversation list: 4 hardcoded contacts (Mara Reyes, Jonah Kessler, Sable Ventures, Devon Nyx). Clicking them does nothing.
- Messages pane: hardcoded 3-message exchange with a hardcoded confidential payment card showing "5 TARI" and a hardcoded note.
- Composer: the text input is a `<span>` (not an `<input>`), the TARI button and send button have no `onClick` handlers.
- The **Balance widget** and **address chip** in the sidebar are real — they pull from `WalletContext`, show actual balance, and open `WalletModal` on click. This is the only live part of the chat screen.
- The `+` new conversation button has no handler.

### Wallet Modal (`WalletModal.tsx`) — tabs

| Tab | State | Notes |
|-----|-------|-------|
| **Overview** | **Fully working** | Real balance from WalletContext scan. Hide/show toggle. Real truncated address + copy. Scan progress indicator. Refresh button. Network badge ("Esmeralda testnet"). Send/Receive shortcut buttons. |
| **Send** | **Fully working** | 5-state machine: form → review → sending → success/error. Validates address prefix (`otl_esm_`), amount > 0, balance ≥ amount + MAX_FEE. Executes real confidential stealth send. Shows tx hash on success. Auto-triggers rescan. Records to txHistory. |
| **Receive** | **Fully working** | Real `QRCodeSVG` (qrcode.react) encoding the actual wallet address. Full address text + copy. |
| **Activity** | **Fully working** | Reads from `txHistory` (localStorage). Shows real sent entries (recorded at send time) and real received entries (discovered by scanner). Sorted newest-first. Empty state when no history. |
| **Settings** | **Fully working** | Three sub-views accessible via gear icon: (1) Recovery phrase — password-gated reveal of all 24 words with copy-all; (2) Decrypt UTXO dev panel; (3) Lock wallet. |

### Other Components

| Component | State |
|-----------|-------|
| `DecryptPanel.tsx` | **Fully working** — fetches real UTXO from indexer, decrypts with view key, displays amount + memo. Stale dev-panel note says "No scanner yet; scanning is Level 2" — scanner was added in commit `425fb47`, comment not updated. |
| `WalletPanel.tsx` | **Orphaned.** The old sidebar drawer, replaced by `WalletModal`. Still exists in the repo but is not imported anywhere. Safe to delete. |
| `Logo.tsx` | Working SVG logo component. |

---

## 4. The Crypto Layer

### Files in `src/crypto/`

**`walletCrypto.ts`** — Key generation and secure storage.
- `createMnemonic()` → `generateMnemonic(wordlist, 256)` from `@scure/bip39` (24-word BIP-39, English wordlist, 256 bits entropy)
- `isMnemonicValid(phrase)` → validates against BIP-39 English wordlist
- `encryptMnemonic(mnemonic, password)` → PBKDF2-SHA-256 (600,000 iterations, 16-byte random salt) → AES-256-GCM (12-byte random IV) → returns `StoredWallet` JSON
- `decryptMnemonic(stored, password)` → inverse; throws `DOMException(OperationError)` on wrong password
- `walletFromMnemonic(mnemonic)` → derives Tari keys (see derivation chain below)
- `hasStoredWallet()` / `loadStoredWallet()` / `saveStoredWallet()` → localStorage key: `caravel.wallet.v1`

**`walletScanner.ts`** — Blind UTXO scan (Monero-style, O(n) over all UTXOs).
- Fetches `GET https://ootle-indexer-a.tari.com/utxos?resource_address=0101...0101&limit=100&offset=N`
- For each UTXO: wraps raw body as fake `IndexerGetSubstateResponse`, calls `decryptOwnedUtxo(crypto, viewSecret, fakeSubstate, substateId)`
- `decryptOwnedUtxo` does AEAD trial-decryption; returns null if not ours
- On success: decodes memo via `decodeMemo()` (handles `PayRefAndBytes`, `Message`, `Bytes`, `U256`, raw fallback)
- Paginates up to 1,000 UTXOs (10 pages × 100). Has per-page 10-second hard timeout. Yields every 50 items to keep UI responsive.
- Returns `ScannedUtxo[]` with `{ id, commitment, amount, payRef, message }` — **does NOT store mask or nonce** (needed for send; confidentialSend.ts re-scans live for those)

**`confidentialSend.ts`** — Browser port of the proven Node.js send script.
- Entry point: `sendConfidential(wallet, senderAddress, params) → { txId, outcome }`
- Internally re-scans all UTXOs (same indexer endpoint, PAGE_SIZE=200, no cap) to recover `mask` + `nonce` per UTXO (dropped by walletScanner.ts)
- Best-fit UTXO selection: filter `value > amount + MAX_FEE`, sort ascending, take first
- Full send sequence (see §4c below)
- Polls tx result 6× at 5s intervals (30s max); returns `'Commit' | 'Reject' | 'Timeout'`
- Also exports `tariToMicrotari(tari: number): bigint` and `MAX_FEE = 10_000n`

**`txHistory.ts`** — Persisted transaction history.
- Types: `SentEntry` (type, id=txHash, recipient, amountMicrotari, note, txHash, timestamp, outcome) and `ReceivedEntry` (type, id=utxoSubstateId, amountMicrotari, note, discoveredAt)
- localStorage key: `caravel.txhistory.v1.{walletAddress}`
- bigint fields stored as decimal strings (JSON doesn't support bigint)
- `loadHistory(addr)` / `addSent(addr, current, params)` / `mergeReceived(addr, current, utxos)` — all pure functions that also write to localStorage
- `mergeReceived` deduplicates by `utxo.id` (substateId); only new UTXOs get added

---

### Key Derivation Chain (mnemonic → otl_esm_ address)

```
24-word BIP-39 mnemonic (256 bits entropy, @scure/bip39 English wordlist)
  ↓  mnemonicToSeed(mnemonic)
  ↓  PBKDF2-HMAC-SHA512, salt="mnemonic", 2048 rounds, no passphrase → 64 bytes

64-byte BIP-39 seed
  ↓  SHA-512(seed ‖ 0x01) → 64 bytes → reduceModL (little-endian mod Ristretto255 L)
ownerSecretKey (32 bytes, valid Ristretto255 scalar)

  ↓  SHA-512(seed ‖ 0x02) → 64 bytes → reduceModL
viewOnlySecret (32 bytes, valid Ristretto255 scalar)

  ↓  SecretKeyWallet.fromSecretKey(ownerSecretKey, Network.Esmeralda, viewOnlySecret)
otl_esm_ address
```

**⚠️ Important:** There is no BIP-32/SLIP-10 HD path. Derivation is flat from the BIP-39 seed via domain-separated SHA-512 + mod-L reduction. This is a **custom Caravel-specific derivation** — standard hardware wallets, MetaMask, or any BIP-32 tool will NOT recover the same address from the same mnemonic. Recovery requires this exact `walletCrypto.ts` code.

`Ristretto255 L = 7237005577332262213973186563042994240857116359379907606001950938285454250989`

---

### Confidential Send — How It Works

Proven architecture from tx `836369ed0e5de2c78754d88449576e2a0102a13d40beb8e42885c6fbc91e8162` on Esmeralda.

**Single-UTXO model:** one input UTXO → recipient output + change output + fee, all produced inside `fee_instructions`. `instructions` array is empty. The fee is carved from the confidential balance — not revealed separately.

**Exact call sequence:**

```
1. IndexerProvider.connect({ url, network })          // must be first — lets __tla tick
2. scanUtxos(crypto, viewSecret)                       // fresh scan to get mask + nonce
3. best-fit UTXO selection                             // smallest UTXO covering amount + MAX_FEE
4. createOutput({ destination: recipient, amount, resourceAddress, memo? })
   createOutput({ destination: senderAddress, amount: changeAmount, resourceAddress })
5. crypto.generateOutputsStatement([recipientOutput, changeOutput], MAX_FEE)
6. crypto.buildInputsStatement([new StealthInput(utxo.commitment)], 0n)
7. signBalanceProof(crypto, utxo.mask, outputMask, insStmt, outsStmt)
8. new StealthTransferStatement(insStmt, outsStmt, proof)
9. TransactionBuilder.addFeeInstruction(stealthTransferInstruction(...))
   TransactionBuilder.addFeeInstruction({ PutLastInstructionOutputOnWorkspace: { key: 0 } })
   TransactionBuilder.addFeeInstruction({ PayFeeFromBucket: { bucket: { id: 0, offset: null } } })
   TransactionBuilder.addInput({ substate_id: stealthUtxoSubstateId(TARI_RESOURCE, commitment), version: null })
10. resolveTransaction(provider, builder.buildUnsignedTransaction())
11. generateSealKeypair()
12. serializeUnsignedTx(unsignedTx)
13. wallet.addStealthSignature(unsignedJson, utxo.nonce, sealKP.public_key, { crypto })
14. new OotleWallet().registerKeyProvider(senderAddress, wallet).setDefaultSigner(senderAddress)
15. signTransaction([ootleWallet, new StaticSigner([oneTimeSig])], unsignedTx, sealKP)
16. sealTransaction(signed)
17. provider.submitTransaction(envelope)  → { transaction_id }
18. poll GET /transactions/{txId}/result × 6, 5s interval
```

**Fee ceiling:** `MAX_FEE = 10_000 µtTARI` (0.01 tTARI). Actual observed: ~1,006 µtTARI.

**`StaticSigner`:** minimal `Signer` implementation that returns pre-computed signatures. Needed because `wallet.addStealthSignature` returns a single `TransactionSignature` but `signTransaction` expects a `Signer[]` array.

**`__tla` ordering:** `IndexerProvider.connect()` must be awaited before any wallet crypto calls. The `ootle-secret-key-wallet` package uses `vite-plugin-top-level-await`; the connect call gives the event loop a tick to resolve the IIFE.

---

### UTXO Scan — How It Works

- **Endpoint:** `GET https://ootle-indexer-a.tari.com/utxos?resource_address=0101...0101&limit=100&offset=N`
- **RESOURCE_HEX:** `0101010101010101010101010101010101010101010101010101010101010101` (64 hex chars = 32 bytes, the Tari native resource address without the `resource_` prefix)
- **Strategy:** Blind scan (Monero-style). Fetches all UTXOs globally for the Tari resource, trial-decrypts each one using the wallet's view secret.
- **Decrypt path:** `decryptOwnedUtxo(WasmStealthCrypto, viewSecret, IndexerGetSubstateResponse, substateId)` — the response is wrapped in a fake `IndexerGetSubstateResponse` (`{ version: 0, verified: false, substate: { Utxo: rawBody } }`) since the scan uses raw API bodies.
- **Memo parsing:** `decodeMemo(memoJson)` — handles four memo formats: `PayRefAndBytes` (wire format: `[1-byte N][N-byte pay_ref][rest: message]`), `Message` (plain string), `Bytes`, `U256`, and raw fallback.
- **Scan cap:** 1,000 UTXOs (10 pages). Sets `capped: true` if hit. Configurable constant `MAX_UTXOS`.

---

### Transaction History — Storage Structure

**localStorage key:** `caravel.txhistory.v1.{walletAddress}` (per-wallet)

**Schema (JSON array):**
```json
[
  {
    "type": "sent",
    "id": "836369ed...",           // txHash
    "recipient": "otl_esm_1...",
    "amountMicrotari": "2000000",  // bigint as decimal string
    "note": "Splitting the villa booking",
    "txHash": "836369ed...",
    "timestamp": 1753012345678,    // Date.now()
    "outcome": "Commit"            // | "Reject" | "Timeout"
  },
  {
    "type": "received",
    "id": "utxo_0101...0101_<commitment>",  // UTXO substateId (dedup key)
    "amountMicrotari": "5000000",
    "note": "Thanks for the booking",
    "discoveredAt": 1753012345678
  }
]
```

Sent entries are added at send time regardless of outcome. Received entries are merged (deduped by `id`) each time a scan completes. Once a received entry is stored, it stays even after the UTXO is spent.

---

## 5. Dependencies and Configuration

### `package.json` — Production Dependencies

| Package | Version | Notes |
|---------|---------|-------|
| `react` | `^19.2.7` | |
| `react-dom` | `^19.2.7` | |
| `react-router-dom` | `^7.18.1` | |
| `@scure/bip39` | `^2.2.0` | BIP-39 mnemonic generation and PBKDF2 seed derivation |
| `@tari-project/ootle-wasm` | `0.35.2` | WASM binary — installed from npm, exact version pinned |
| `qrcode.react` | `^4.2.0` | QR code SVG rendering |

### `package.json` — Dev Dependencies

| Package | Version | Notes |
|---------|---------|-------|
| `vite` | `^8.1.1` | |
| `@vitejs/plugin-react` | `^6.0.3` | |
| `vite-plugin-wasm` | `^3.6.0` | Handles `*.wasm` imports |
| `typescript` | `~6.0.2` | Exact minor pinned |
| `@types/react` | `^19.2.17` | |
| `@types/react-dom` | `^19.2.3` | |
| `@types/node` | `^24.13.2` | |
| `oxlint` | `^1.71.0` | Linter (not ESLint) |

### Packages NOT in `package.json` (aliased directly)

| Package | Version | How linked |
|---------|---------|------------|
| `@tari-project/ootle` | 0.1.0 | Vite alias → `caravel/tarijs-reference/packages/ootle/dist/index.js` |
| `@tari-project/ootle-indexer` | 0.1.0 | Vite alias → `caravel/tarijs-reference/packages/ootle-indexer/dist/index.js` |
| `@tari-project/ootle-secret-key-wallet` | 0.1.0 | Vite alias → `caravel/tarijs-reference/packages/ootle-secret-key-wallet/dist/index.js` |

**The `tari-project-indexer-client-1.4.2.tgz`** is committed to the repo root and appears in `package-lock.json` but is **never imported** by any source file. Its purpose is unknown — possibly an early exploration artifact.

### How tari.js is Linked

`vite.config.ts` uses `resolve.alias` to point three `@tari-project/*` imports at pre-built ES module dist files in `~/Desktop/caravel/tarijs-reference/packages/*/dist/index.js`. This is an **absolute path hardcoded to the developer's machine** — the app will not build on any other machine without those files present at that exact path.

All three packages are also listed in `optimizeDeps.exclude` so Vite's esbuild pre-bundler does not touch them (necessary because they contain WASM and top-level-await).

`tsconfig.app.json` `paths` mirrors these aliases for TypeScript type resolution.

### Vite Config

```typescript
plugins: [wasm(), react()]      // wasm() must come before react()
build.target: 'esnext'          // required for top-level-await and WASM
optimizeDeps.exclude: [         // skip esbuild pre-bundling for WASM/TLA packages
  '@tari-project/ootle-wasm',
  '@tari-project/ootle',
  '@tari-project/ootle-secret-key-wallet',
  '@tari-project/ootle-indexer',
]
```

**Known non-fatal build error:** `vite.config.ts` produces `TS2349: This expression is not callable` for `wasm()` and `walletCrypto.ts` produces a `SharedArrayBuffer` assignability error. Both are pre-existing and do not affect the runtime build. `tsc --noEmit` (which uses `tsconfig.app.json`) shows zero errors.

### localStorage Keys

| Key | Contents |
|-----|----------|
| `caravel.wallet.v1` | `StoredWallet` JSON: `{ version: 1, kdf: 'pbkdf2', iterations, salt, iv, ciphertext }` — AES-GCM encrypted BIP-39 mnemonic |
| `caravel.txhistory.v1.{address}` | JSON array of `TxEntry` objects (sent + received), bigints as decimal strings |

---

## 6. Known Issues

### Dead Code / Orphans

- **`WalletPanel.tsx`** — Old sidebar drawer, fully replaced by `WalletModal.tsx` in commit `c5a4730`. Still in the repo, not imported anywhere. Safe to delete.
- **`src/assets/hero.png`, `react.svg`, `vite.svg`** — Scaffold assets, never imported.
- **`tari-project-indexer-client-1.4.2.tgz`** — Committed to repo root, in `package-lock.json`, but no source file imports from it.
- **`SdkTest.tsx`** — Added in `03ecc4b`, removed in `16690cf`. Gone from repo but its ghost is in git history.

### Stale Comment

- **`DecryptPanel.tsx` line 118:** `"No scanner yet; scanning is Level 2."` — The UTXO scanner was shipped in commit `425fb47`. This comment is stale.

### Hardcoded Values That Should Be Configurable

- **Indexer URL:** `'https://ootle-indexer-a.tari.com'` appears in three places independently: `walletScanner.ts` (as `INDEXER`), `confidentialSend.ts` (as `INDEXER_URL`), and `DecryptPanel.tsx` (as `INDEXER`). No shared constant.
- **Network:** `Network.Esmeralda` hardcoded in `walletCrypto.ts`, `walletScanner.ts`, `confidentialSend.ts`, `DecryptPanel.tsx`. The UI also hardcodes the string `"Esmeralda testnet"` in `WalletModal.tsx` and `WalletPanel.tsx`.
- **`MAX_FEE = 10_000n`** — hardcoded in `confidentialSend.ts`. Reasonable for testnet but should eventually come from network parameters.
- **`PAGE_SIZE`** — inconsistent: `walletScanner.ts` uses 100, `confidentialSend.ts` uses 200.
- **`MAX_UTXOS = 1000`** in `walletScanner.ts` — caps scan at 1,000 UTXOs; the send scanner in `confidentialSend.ts` has no such cap.
- **`KDF_ITERATIONS = 600_000`** — fine as-is but not surfaced anywhere.
- **Tari resource address (`RESOURCE_HEX`)** — hardcoded in both `walletScanner.ts` and `confidentialSend.ts` (derived from `TARI_RESOURCE_ADDRESS` in the latter). The canonical source is the `TARI_RESOURCE_ADDRESS` constant exported from `@tari-project/ootle`.

### Chat UI — Everything is Mock

The entire right panel of `ChatApp.tsx` is hardcoded static HTML with no state or event handlers. Conversations, messages, timestamps, names, the confidential payment card, the message composer — all are non-functional UI. The TARI payment button does nothing. The message input is a `<span>`, not an input element.

### Landing Page Nav Links

"How it works" and "Privacy" in the navbar, and the "How it works" button in the hero, have no `onClick` handlers. They render as inert elements.

### Two Separate WasmStealthCrypto Instances

`walletScanner.ts` creates one module-level shared instance (`const stealthCrypto = new WasmStealthCrypto(Network.Esmeralda)`). `confidentialSend.ts` creates a new instance per send inside `sendConfidential()`. Both work, but the send function could reuse a shared instance for marginal efficiency.

### `DecryptPanel.tsx` Uses Deprecated `getViewOnlySecret()`

Line 84: `wallet.getViewOnlySecret()` (deprecated, sync, returns `Uint8Array | null`). The preferred method is `await wallet.getViewSecret()` (async, throws rather than returns null). Works, but inconsistent with the rest of the codebase.

### Absolute Path Dependency

`vite.config.ts` has `path.resolve('/Users/okansaglam/Desktop/caravel/tarijs-reference')` hardcoded. The app will not build on any other machine without manually editing this path.

---

## 7. Secrets Check

### caravel-app

- **No secrets committed** in any file or in git history. `git log --all -p -- src/ | grep API_KEY/SECRET/TOKEN` found nothing.
- `.gitignore` correctly excludes `.env`, `.env.*`, `*.token`, `*.key`, `secrets/`.
- Confirmed: no wallet keys, no API keys, no credentials in the committed codebase.

### caravel (research repo)

- **`.env` contains a live API key** — `TARI_API_KEY=tw_OFM9L6VBcFpSEHI0iLXEeeGTydmR7nuP80lSOdoi0F4`. This file is **gitignored** (`.env` is in `.gitignore`) and is **not committed** to the repo. Low risk as long as `.gitignore` stays intact, but the key is a Tari wallet daemon auth token and should be treated as sensitive.

- **`wallet-b.json` contains real key material** — owner secret key, view key, owner public key, view public key, and the wallet address `otl_esm_1gef32ek...`. This file is **untracked** (not in `.gitignore` explicitly, just never staged). It should either be added to `.gitignore` or deleted. It is the test wallet used for research/proving the send flow.

- All four commits in the research repo are clean — no secrets in history.

### Summary

Neither repo has secrets committed to git history. The risks are local-only: the `.env` API key and `wallet-b.json` key material exist on disk but not in version control. `wallet-b.json` should be explicitly gitignored in the research repo.
