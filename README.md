# Caravel

Encrypted chat with private TARI payments, on the [Tari Ootle](https://www.tari.com/) mainnet.

Caravel is a browser app for end-to-end encrypted messaging over Nostr, with confidential TARI
payments you send right inside a conversation. Payments go through
[Sapient](https://chromewebstore.google.com/detail/tari-ootle-wallet/demkeckolenopkgnfbnpflkpbbdhpgkl),
the Tari browser wallet. Caravel never holds your funds or your wallet keys.

## How it works

**Chat identity.** Creating an identity gives you a Nostr key and a 12-word backup phrase (or
import an existing one, or an `nsec`). It is encrypted on your device under a chat password;
there is no account and no server holding it. Messages are Nostr direct messages, NIP-44
encrypted inside NIP-59 gift wraps, so relays can neither read them nor see who sent them. Images
are encrypted before they are uploaded to Blossom servers. Your history is stored locally,
encrypted with a key that lives inside your identity.

**Payments, through Sapient.** Connect Sapient (Chrome, Brave or Edge) and grant view access.
Sending a payment asks Sapient to make a confidential TARI transfer, which you approve in
Sapient; Caravel then tells the recipient, in an encrypted message, which output is theirs. The
recipient's Caravel claims it through their own Sapient and shows it as received only when the
output's note carries that message's one-time code. Payments to an address on a different network
than your wallet's are refused.

## Run it locally

Requires Node 20+ and, for payments, Sapient in a Chromium browser.

```
git clone https://github.com/okansaglam016161-pixel/caravel.git
cd caravel
npm install
npm run dev        # Vite prints the local URL: / is the landing page, /app the chat
```

Sapient talks to `https://` sites and to `http://localhost`, so the dev server works with it as is.

```
npm run build      # type-check (tsc -b) + production bundle
npm run preview    # serve the production build locally
npm run lint       # oxlint
```

## Tests

```
npm test           # unit tests (vitest)
npm run test:live  # live end-to-end checks against real Nostr relays and Blossom servers
```

## License

MIT: see [LICENSE](LICENSE).
