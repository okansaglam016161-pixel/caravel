# Caravel

**The vessel for a new era of private exchange.**

Caravel puts private messages over Nostr and private payments on the Tari Ootle in one
conversation. It runs in your browser, and it never holds your funds or your wallet keys.

[caravellabs.net](https://caravellabs.net)

## How it works

**Chat identity.** Your identity is a Nostr key, made on your device and backed up with 12 words
(a standard NIP-06 phrase), or imported from an existing `nsec`. It is stored on your device,
encrypted with your chat password. There is no account and no server holding it.

**Messaging.** Messages are Nostr direct messages: encrypted with NIP-44 and sealed in NIP-59 gift
wraps, so relays can neither read them nor see who sent them. One-to-one and group chats support
replies, reactions and edits. Images are encrypted on your device (AES-256-GCM) before they are
uploaded to Blossom servers. Your history is kept on your device, encrypted with a key that lives
inside your identity.

**Payments.** Payments go through [Sapient](https://chromewebstore.google.com/detail/tari-ootle-wallet/demkeckolenopkgnfbnpflkpbbdhpgkl),
the Tari browser wallet. In a one-to-one chat, you send confidential TARI on the Ootle: Sapient
asks you to approve the transfer, and the amount is hidden on chain. Caravel then tells the
recipient, in an encrypted message, which output is theirs and attaches a one-time code. The
recipient's Caravel claims the payment through their own Sapient and marks it as received only if
the payment's note carries that code. Payments to an address on a different network than your
wallet's are refused.

## Getting started

1. Use a desktop browser: Chrome, Brave or Edge.
2. Install [Sapient](https://chromewebstore.google.com/detail/tari-ootle-wallet/demkeckolenopkgnfbnpflkpbbdhpgkl)
   and set up your wallet there.
3. Open [caravellabs.net](https://caravellabs.net), choose **Launch Caravel** and create your chat
   identity. Write down the 12 words and pick a chat password.
4. Connect Sapient from the wallet button at the top of the chat list, and grant view access so
   Caravel can confirm payments you receive.
5. Start a conversation by pasting someone's `npub`. Share your own npub (in Profile) so people can
   reach you. Your wallet address is shared with a contact automatically when you message them.

## Anonymous usage count

When you create a chat identity, and the first time you connect Sapient, Caravel publishes one
empty Nostr note (kind 30078, tag `caravel/identity_created` or `caravel/wallet_connected`). It is
signed by a brand-new random key that is used once and thrown away, dated to the day, and sent a
few hours later. It contains no npub, address, amount or anything else. The relays that receive it
see your IP address, as they do for your messages. The landing page shows how many identity notes
exist, read with Nostr COUNT from public relays.

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

## Credits and licence

Caravel is released under the MIT licence: see [LICENSE](LICENSE).

Sapient icon by 0xhra, MIT licence.
