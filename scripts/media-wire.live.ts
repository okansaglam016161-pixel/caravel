// LIVE end-to-end proof of the media wire (images M3): two wallets, real relays, real Blossom host.
//
//   npm run test:live
//
// This is the "two-wallet test" in automated form. M3 ships no UI, so the alternative was poking at
// React context from a browser console; this proves the same thing repeatably and in CI-able form:
//
//   sender:    encrypt → upload ciphertext → gift-wrap a MediaRef → publish to real relays
//   recipient: subscribe → receive → unwrap → MediaRef intact → download → verify → decrypt → compare
//
// The canvas downscale is the one stage NOT covered (createImageBitmap needs a browser), so this
// starts from bytes rather than from a File. Everything after that is the real shipped path.
//
// NOT part of `npm test` — it needs relays, a blob host, and several seconds.

import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { NostrMessagingProvider } from '../src/messaging/NostrMessagingProvider'
import { DEFAULT_RELAYS } from '../src/config/relays'
import { encryptMedia } from '../src/crypto/mediaCrypto'
import { downloadAndDecrypt, uploadEncryptedBlob } from '../src/crypto/blossomClient'
import type { CaravelMessage, MediaRef } from '../src/messaging/types'

const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')

// getRandomValues caps at 65,536 bytes per call.
function randomBytes(total: number): Uint8Array {
  const out = new Uint8Array(total)
  for (let offset = 0; offset < total; offset += 65_536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65_536, total)))
  }
  return out
}

describe('media wire, end to end over real relays', () => {
  it('delivers an encrypted image from one wallet to another', async () => {
    const senderSk = generateSecretKey()
    const recipientSk = generateSecretKey()
    const senderPk = getPublicKey(senderSk)
    const recipientPk = getPublicKey(recipientSk)

    const sender = new NostrMessagingProvider(hex(senderSk), senderPk, DEFAULT_RELAYS)
    const recipient = new NostrMessagingProvider(hex(recipientSk), recipientPk, DEFAULT_RELAYS)

    try {
      // ── recipient comes online first, or the message races the subscription
      const received: CaravelMessage[] = []
      recipient.subscribe(msg => { received.push(msg) })
      // Give the relay handshakes a moment to settle before publishing.
      await new Promise(r => setTimeout(r, 3_000))

      // ── sender: encrypt and upload the "image"
      const imageBytes = randomBytes(64 * 1024).buffer
      const enc = await encryptMedia(imageBytes)
      const upload = await uploadEncryptedBlob(enc.ciphertext, enc.x)
      expect(upload.status, JSON.stringify(upload)).toBe('ok')
      if (upload.status !== 'ok') return

      const media: MediaRef = {
        url: upload.url,
        key: enc.keyB64,
        nonce: enc.nonceB64,
        mime: 'image/webp',
        x: enc.x,
        ox: enc.ox,
        width: 1600,
        height: 1200,
        size: enc.ciphertext.byteLength,
      }

      // ── send it as a CAPTIONLESS image: the harder case, because a single-space content is what
      // the receive path used to treat as "nothing to show".
      const sent = await sender.sendMessage(recipientPk, ' ', undefined, undefined, media)
      expect(sent.media).toEqual(media)

      // ── wait for it to come back around through the relays
      const deadline = Date.now() + 45_000
      let arrived: CaravelMessage | undefined
      while (Date.now() < deadline) {
        arrived = received.find(m => m.media?.x === enc.x)
        if (arrived) break
        await new Promise(r => setTimeout(r, 500))
      }

      expect(arrived, 'media message never arrived over the relays').toBeDefined()
      if (!arrived) return

      // The reference must survive the wire byte-identical — this is the whole milestone.
      expect(arrived.media).toEqual(media)
      expect(arrived.senderPubkeyHex).toBe(senderPk)   // authenticated, not self-declared
      expect(arrived.plaintext).toBe(' ')              // captionless, and NOT dropped

      // ── the recipient can actually turn that reference back into the image
      const out = await downloadAndDecrypt(arrived.media!.url, arrived.media!.x, arrived.media!.key, arrived.media!.nonce)
      expect(out.status, JSON.stringify(out)).toBe('ok')
      if (out.status !== 'ok') return
      expect([...new Uint8Array(out.bytes)]).toEqual([...new Uint8Array(imageBytes)])
    } finally {
      sender.disconnect()
      recipient.disconnect()
    }
  })
})
