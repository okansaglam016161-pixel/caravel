# Caravel

**Private messages, private money. One conversation.**

Caravel fuses end-to-end encrypted messaging with confidential payments on the
[Tari Ootle](https://www.tari.com/) L2. It's a self-custodial wallet that runs entirely in your
browser — your keys are generated on your device and never leave it. One 24-word recovery phrase
restores both your money and your messages.

## Features

- **End-to-end encrypted messaging** — Nostr gift-wrapped direct messages (NIP-17); only you and
  your recipient can read them.
- **Confidential in-chat payments** — attach a Tari payment to any message; the amount is hidden
  on-chain and only the recipient sees the note.
- **Pay by name** — register an on-chain `@name` (ONS) that resolves to your messaging key.
- **Self-custodial browser wallet** — keys created and held on your device; no server, no custody.
- **Contact requests & address exchange** — accept/decline incoming requests; Tari addresses are
  exchanged in-band, never resolved from a name.

## Tech stack

- **UI:** React 19, react-router 7, Vite 8, TypeScript 6 (linted with oxlint)
- **Tari / Ootle:** `@tari-project/ootle-wasm` 0.35.2 (WASM confidential-transfer crypto) + the
  Ootle SDK (vendored — see below)
- **Crypto:** `@scure/bip39`, `@scure/bip32`, `@noble/curves`
- **Messaging:** `nostr-tools` 2.x
- **Misc:** `qrcode.react`

## Getting started

**Prerequisites:** Node 20+ (tested on 24).

```sh
git clone https://github.com/okansaglam016161-pixel/caravel.git
cd caravel-app
npm install
npm run dev      # → http://localhost:5174   (/ = landing, /app = wallet)
```

Other scripts:

```sh
npm run build    # type-check (tsc -b) + production bundle (vite build)
npm run lint     # oxlint
npm run preview  # serve the production build locally
```

## Dependencies note

The Tari Ootle SDK (`@tari-project/ootle*`) and the ONS client (`@ootle/name-service`) are
**vendored** as pre-built dists under [`vendor/`](vendor/) so the repo builds on a fresh clone with
no external setup. The Tari SDK is the official BSD-3 build, aligned to the current Esmeralda wire
format (the npm-published version is older and ABI-incompatible with `ootle-wasm 0.35.2`); the ONS
client is this project's own, not yet published. Both will move to npm packages once published
upstream. See [`vendor/README.md`](vendor/README.md).

## Project structure

```
src/
  components/
    landing/      Public marketing landing page
    chat/         Chat shell — conversations, thread view, compose, payments
    wallet/       Create / unlock / restore, wallet modal, profile, ONS register
    primitives/   Shared UI kit (tokens, Logo, buttons, inputs, …)
  context/        WalletContext — wallet + scan + messaging state
  crypto/         Key derivation, UTXO scan, confidential send, ONS, Nostr crypto
  messaging/      Nostr provider + per-identity local stores
  config/         Relay configuration
docs/DERIVATION.md   How the wallet + Nostr identities derive from one BIP-39 phrase
```

## Docs

- [`docs/DERIVATION.md`](docs/DERIVATION.md) — key derivation: how the Tari wallet and Nostr
  identity both come from the same 24-word phrase.

## Status & security

- **Testnet only** — runs against the Tari **Esmeralda** testnet.
- **Self-custodial** — keys never leave your device. Your **recovery phrase is the only way to
  recover** your wallet; lose it and both funds and messages are gone.
- **Unaudited** — testnet software under active development.

## License

Private / all rights reserved.
