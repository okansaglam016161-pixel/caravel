// LIVE seeding script — mints a fresh Caravel wallet holding REVEALED tTARI (M2 CP1a).
//
//   npm run test:live
//
// NOT product code and never shipped. It exists to solve a bootstrapping problem: conceal moves
// value from revealed to private, but no Caravel wallet has ever held a revealed balance — the
// faucet claim in faucet.ts withdraws its entire payout and converts it in the same transaction,
// leaving the vault at exactly zero. So there is nothing to conceal FROM, and no way to test M2.
//
// This mints one, by running the claim WITHOUT the conversion:
//
//     CreateAccount(ownerPk)                  → 'account'
//     callMethod(faucet, 'take', [account])   → deposits ~1000 tTARI REVEALED into the vault
//     callMethod(account, 'pay_fee', [fee])   → fee paid straight from that revealed balance
//
// No StealthTransfer, no masks, no balance proof, no range proof — the simplest transaction in this
// codebase. It is not speculative either: it is the shape the official wallet daemon's own claim
// used (tx f2c7e128…, committed on Esmeralda), which is exactly why its account still holds ~999.6
// tTARI revealed. `Account::pay_fee` draws directly from the stealth vault's revealed amount
// (tari-ootle: template_builtin/templates/account/src/lib.rs:173), so no conversion is needed to
// cover the fee.
//
// A FRESH WALLET IS REQUIRED. The faucet mints and burns a claim NFT per public key, so a wallet
// that has already claimed can never claim again. The script generates a new CipherSeed through
// Caravel's own derivation and prints its mnemonic, so the result can be imported through the
// restore UI and used to exercise the conceal flow — and to give M1's populated public-balance row
// its first render against real data.
//
// IT SPENDS REAL TESTNET FAUCET FUNDS on every run, which is why it is opt-in rather than part of
// `npm test`.

import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  Network,
  TransactionBuilder,
  XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
  XTR_FAUCET_COMPONENT_ADDRESS,
  XTR_FAUCET_VAULT_ADDRESS,
  amountLiteral,
  sealTransaction,
  signTransaction,
} from '@tari-project/ootle'
import { IndexerProvider } from '@tari-project/ootle-indexer'
import { createWalletSeed } from '../vendor/tari-cipherseed/src/index'
import { deriveIdentity } from '../src/crypto/derivation'
import { extractAccountAddress } from '../src/crypto/accountAddress'
import { readRevealedBalance } from '../src/crypto/revealedBalance'
import { nextMaxEpoch } from '../src/crypto/epoch'
import { dryRunFee, withFeeMargin } from '../src/crypto/feeProbe'

const INDEXER_URL = 'https://ootle-indexer-a.tari.com'

/**
 * Where the seeded wallet is recorded, IN ADDITION to being printed.
 *
 * Learned the hard way on the first run: vitest buffers test stdout, the console output never
 * surfaced, and a wallet holding 1000 revealed tTARI was stranded because its mnemonic existed
 * nowhere else. A seeding script whose only output can be lost to a scrollback is a broken seeding
 * script. Gitignored (.gitignore:31 covers .claude/, and this path is outside the repo entirely).
 */
const OUT_FILE = '/private/tmp/claude-501/-Users-okz61-Desktop-caravel/5d7a5736-af17-420f-b568-4461506f1113/scratchpad/seeded-wallet.txt'

/** Reserved for the DRY RUN only. Generous so the simulation runs to completion; refunded. */
const FEE_PROBE_MICROTARI = 200_000n

const TARI = 1_000_000n
const fmt = (µt: bigint) => `${(µt / TARI).toLocaleString('en-US')}.${(µt % TARI).toString().padStart(6, '0')} tTARI`

function toHexStr(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

describe('seed a wallet with a REVEALED balance', () => {
  it('claims the faucet without converting, leaving the payout revealed', async () => {
    // ── A brand-new wallet, through Caravel's own derivation ──
    const { mnemonic } = await createWalletSeed()
    const { wallet } = await deriveIdentity(mnemonic, 'cipherseed')
    const ownerAddress = await wallet.getAddress()
    const ownerPkHex = toHexStr(await wallet.getPublicKey())

    const provider = await IndexerProvider.connect({ url: INDEXER_URL, network: Network.Esmeralda })
    const maxEpoch = await nextMaxEpoch(provider)

    // The recipe, as a function of the fee — same discipline as faucet.ts, so the priced
    // transaction and the submitted one can only differ in that number.
    async function buildEnvelope(feeMicrotari: bigint, dryRun: boolean) {
      const builder = new TransactionBuilder(Network.Esmeralda, maxEpoch)
        .withFeeInstructionsBuilder((b) =>
          b
            .createAccount(ownerPkHex)
            .saveVar('account')
            .callMethod({ componentAddress: XTR_FAUCET_COMPONENT_ADDRESS, methodName: 'take' }, [{ Workspace: 'account' }])
            // The whole point: NO StealthTransfer. The payout stays revealed in the vault, and the
            // fee comes straight out of it.
            .callMethod({ fromWorkspace: 'account', methodName: 'pay_fee' }, [amountLiteral(feeMicrotari)]),
        )
        .withInputs([
          { substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null },
          { substate_id: XTR_FAUCET_VAULT_ADDRESS, version: null },
          { substate_id: XTR_FAUCET_CLAIM_RESOURCE_ADDRESS, version: null },
        ])
      const unsigned = builder.buildUnsignedTransaction()
      const signed = await signTransaction([wallet], dryRun ? { ...unsigned, dry_run: true } : unsigned)
      return sealTransaction(signed)
    }

    console.log('\n  Seeding a fresh wallet…')
    console.log(`  owner address : ${ownerAddress}`)
    console.log(`  owner pubkey  : ${ownerPkHex}`)

    // ── Price it, then send it ──
    const probe = await buildEnvelope(FEE_PROBE_MICROTARI, true)
    const cost = await dryRunFee(INDEXER_URL, probe)
    const fee = withFeeMargin(cost)
    console.log(`  measured fee  : ${cost} µtTARI (reserving ${fee} with margin)`)

    const sub = await provider.submitTransaction(await buildEnvelope(fee, false))
    const txId = sub.transaction_id as string
    console.log(`  tx            : ${txId}`)

    // ── Wait for a decision, and read the account address out of the same result ──
    let decision: string | undefined
    let accountAddress: string | null = null
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(r => setTimeout(r, 4_000))
      const res = await fetch(`${INDEXER_URL}/transactions/${txId}/result`)
      if (!res.ok) continue
      const json = await res.json() as { result?: { Finalized?: { final_decision?: string } } }
      decision = json.result?.Finalized?.final_decision
      if (decision === 'Commit') { accountAddress = extractAccountAddress(json, ownerPkHex); break }
      if (decision) break
    }
    expect(decision, 'claim did not commit').toBe('Commit')
    expect(accountAddress, 'no account component in the result').toBeTruthy()

    // ── Confirm on-chain, through M1's own read path ──
    // Deliberately readRevealedBalance and not fetchRevealedBalance: the latter reads localStorage,
    // which does not exist here. This also gives M1's decoder its first run against real data.
    const revealed = await readRevealedBalance(provider, accountAddress)
    provider.stopWatcher?.()

    const record = [
      `seeded ${new Date().toISOString()}`,
      `owner address : ${ownerAddress}`,
      `owner pubkey  : ${ownerPkHex}`,
      `account       : ${accountAddress}`,
      `tx            : ${txId}`,
      `REVEALED      : ${fmt(revealed)}  (${revealed} µtTARI)`,
      '',
      'IMPORT THIS INTO CARAVEL (restore flow):',
      mnemonic,
      '',
    ].join('\n')
    writeFileSync(OUT_FILE, record)
    console.log('\n' + record)
    console.log(`  (also written to ${OUT_FILE})\n`)

    // The payout is 1000 tTARI minus the fee, so anything near it proves the value stayed revealed.
    expect(revealed).toBeGreaterThan(900n * TARI)
    expect(revealed).toBeLessThanOrEqual(1000n * TARI)
  }, 180_000)
})
