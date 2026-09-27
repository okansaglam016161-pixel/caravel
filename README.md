# Caravel

**A Swiss bank account in your pocket.**

For a century, a Swiss bank account meant one thing: your money was yours, and no one
else's business. That privilege was for the few.

Caravel puts it in your pocket. Built on the [Tari Ootle](https://www.tari.com/) L2, it's
the start of a private neo-bank, expanding privacy services one at a time. It runs entirely
in your browser, self-custodial, with nothing to install. One 24-word recovery phrase
restores both your money and your messages.

## Live today

**Wallet.** Hold funds privately or publicly, and disclose only when you choose. Send,
receive, and move value between private and public at will. Your private balance lives in
confidential outputs on the Ootle.

**Chat.** Private messages and private money in one conversation. Messages are end-to-end
encrypted over Nostr and gift-wrapped so relays can't read them or see who sent them, with
payments built right into the chat. Register an on-chain `@name` through Caravel Name
Service and start talking with a simple handle.

## Features

* **End-to-end encrypted messaging** — Nostr gift-wrapped direct messages (NIP-44
  encryption inside NIP-59 gift wraps); only you and your recipient can read them, and
  relays never see who sent them.
* **In-chat confidential payments** — attach a Tari payment to any message; the amount is
  confidential on-chain.
* **Message by name** — register an on-chain `@name` (Caravel Name Service) that resolves
  to your messaging key.
* **Self-custodial browser wallet** — keys created and held on your device; no server, no
  custody.
* **Contact requests** — accept or decline incoming requests before a conversation begins.

## Tech stack

* **UI:** React 19, Vite 8, TypeScript 5.9 (linted with oxlint)
* **Tari / Ootle:** `@tari-project/ootle` 0.5.0, with confidential-transfer crypto in
  WebAssembly (`@tari-project/ootle-wasm`)
* **Crypto:** `@scure/bip39`, `@scure/bip32`, `@noble/curves`
* **Messaging:** `nostr-tools` 2.x
* **Misc:** `qrcode.react`

## Getting started

Prerequisites: Node 20+ (tested on 24).

```
git clone https://github.com/okansaglam016161-pixel/caravel.git
cd caravel
npm install
npm run dev      # → http://localhost:5174   (/ = landing, /app = wallet)
```

Other scripts:

```
npm run build    # type-check (tsc -b) + production bundle (vite build)
npm run lint     # oxlint
npm run preview  # serve the production build locally
```

## Dependencies note

The Tari Ootle SDK (`@tari-project/ootle`) is installed from npm. The Caravel Name Service
client is vendored as a pre-built dist under `vendor/ons/`, patched with a fix that isn't
yet upstream, so the repo builds on a fresh clone with no external setup. See
`vendor/README.md`.

## Project structure

```
src/
  components/
    landing/      Public marketing landing page
    chat/         Chat shell — conversations, thread view, compose, payments, @names
    wallet/       Create / unlock / restore, wallet modal, profile
    primitives/   Shared UI kit (tokens, Logo, buttons, inputs, …)
  context/        WalletContext — wallet + scan + messaging state
  crypto/         Key derivation, UTXO scan, confidential send, ONS, Nostr crypto
  messaging/      Nostr provider + per-identity local stores
  config/         Relay configuration
docs/             Derivation and known-issues documentation
```

## Docs

* `docs/DERIVATION.md` — how the Tari wallet and Nostr identity both derive from the same
  24-word phrase.
* `docs/KNOWN_ISSUES.md` — diagnosed but not-yet-fixed defects, including what was ruled
  out, so a fix doesn't repeat the investigation.

## Status & security

* **Testnet only** — runs against the Tari Esmeralda testnet.
* **Self-custodial** — keys never leave your device. Your recovery phrase is the only way
  to recover your wallet; lose it and both funds and messages are gone.
* **Unaudited** — testnet software under active development.

## License

MIT — see [LICENSE](LICENSE).
