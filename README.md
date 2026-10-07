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
confidential outputs on the Ootle. A new wallet can claim 1,000 tTARI of test funds from the
[Caravel Faucet](https://github.com/okansaglam016161-pixel/caravel-faucet).

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
* **Testnet faucet** — 1,000 tTARI per claim, one claim per wallet key across all apps, paid
  out privately; a zero-balance wallet can claim because the fee comes out of the claim.

## Tech stack

* **UI:** React 19, Vite 8, TypeScript 6.0 (linted with oxlint)
* **Network:** Ootle 0.45 (protocol V1) on esmeralda testnet
* **Tari / Ootle:** `@tari-project/ootle` SDK 0.7 (with `-indexer` and `-secret-key-wallet`),
  with confidential-transfer crypto in WebAssembly (`@tari-project/ootle-wasm` 0.43)
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
client is vendored as a pre-built dist under `vendor/ons/`, built from the
[ootle-name-service](https://github.com/okansaglam016161-pixel/ootle-name-service) source with no local patches, so the repo builds on a fresh clone with no external setup. See
`vendor/README.md`.

## Contracts

Both are published on Ootle 0.42, running on 0.45 (re-verified live on 0.45).

| | address (esmeralda) |
|---|---|
| Caravel Name Service registry (the [Ootle Name Service](https://github.com/okansaglam016161-pixel/ootle-name-service) contract) | `component_0109d5287493affc06ec8902fcbf85bd2362832580feeac2a70cba7e5ac6da4d` |
| [Caravel Faucet](https://github.com/okansaglam016161-pixel/caravel-faucet) | `component_568f84a0cc7ccfe49116ee86d072f02b99e246a4750e680a8cbfcd2b7862f37b` |

The faucet is funded with 598,000 tTARI.

## Project structure

```
src/
  components/
    landing/      Public marketing landing page
    shell/        App shell — service navigation (wallet, chat)
    chat/         Chat shell — conversations, thread view, compose, payments, @names
    wallet/       Create / unlock / restore, wallet modal, faucet, profile
    primitives/   Shared UI kit (tokens, Logo, buttons, inputs, …)
  context/        WalletContext — wallet + scan + messaging state
  crypto/         Key derivation, UTXO scan, confidential send, ONS, faucet, Nostr crypto
  hooks/          React hooks over the crypto and storage modules
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

* **Testnet only** — runs on Ootle 0.45 (protocol V1) on esmeralda testnet. Amounts are shown as TARI
  (tTARI on-chain).
* **Self-custodial** — keys never leave your device. Your recovery phrase is the only way
  to recover your wallet; lose it and both funds and messages are gone.
* **Unaudited** — testnet software under active development.

## License

MIT — see [LICENSE](LICENSE).
