// A wallet whose public account does not exist on chain yet, picking each public leg of a trade.
//
// The 0.47 matrix: wallet C had only ever held private funds (the faucet pays private), so its account
// component had never been created. Unlock still stores the account ADDRESS (accountRecovery derives it
// with a dry-run CreateAccount), so every `!t.account` guard passed, the fill declared a component that
// does not exist, the fee estimate came back "Input substate component_… does not exist", and the Trade
// sheet read that as "Someone just took this order" while the order sat open on the book.
//
// The rule these pin:
//   RECEIVING into public (a fill's "receive public", a placement's "get paid public") creates the
//     account inside the trade — CreateAccount, permissionless on default rules — and never declares
//     the missing component;
//   PAYING from public (pay public, public escrow, a cancel back to public — whose fee the account pays)
//     refuses BEFORE anything is priced, with a plain message;
//   an account that EXISTS is declared and deposited into, never re-created (that would mint a
//     throwaway account in the working state);
//   an account nobody can vouch for either way is refused, never guessed.
//
// Real WASM coins and a real wallet build and seal the real transaction; only the network is mocked.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Network, TARI_RESOURCE_ADDRESS, WasmStealthCrypto, createOutput,
} from '@tari-project/ootle'
import { SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'

const ACCOUNT = 'component_' + 'ac'.repeat(32)
const MAKER_PAYOUT = 'component_' + '99'.repeat(32)
const ORDER_ID = 'component_' + 'de'.repeat(32)
const state = { account: 'absent' as 'absent' | 'verified' | 'unknown' }
const priced: unknown[] = []
/** Every transaction signed, unsigned form — what the network is asked to run, readable. */
const signed: unknown[] = []

vi.mock('@tari-project/ootle', async (actual) => {
  const real = await actual<typeof import('@tari-project/ootle')>()
  return {
    ...real,
    signTransaction: vi.fn(async (signers: never, unsigned: unknown, seal?: never) => {
      signed.push(unsigned)
      return real.signTransaction(signers, unsigned as never, seal)
    }),
  }
})

vi.mock('@tari-project/ootle-indexer', () => ({ IndexerProvider: { connect: vi.fn(async () => ({ stopWatcher() {} })) } }))
vi.mock('./epoch', () => ({ nextMaxEpoch: vi.fn(async () => 1000) }))
vi.mock('./feeProbe', async (actual) => ({
  ...(await actual<typeof import('./feeProbe')>()),
  dryRunFee: vi.fn(async (_url: string, envelope: unknown) => { priced.push(envelope); return 20_000n }),
  simulateFee: vi.fn(async (_url: string, envelope: unknown) => { priced.push(envelope); return { accepted: true, cost: 20_000n } }),
}))
vi.mock('./submitGuard', async (actual) => ({
  ...(await actual<typeof import('./submitGuard')>()),
  versionsUnchanged: vi.fn(async () => async () => 'not-landed' as const),
}))
vi.mock('./cusdScan', async (actual) => ({
  ...(await actual<typeof import('./cusdScan')>()),
  verifiedRead: vi.fn(async (path: string) => {
    if (path.includes(ACCOUNT)) {
      return state.account === 'verified' ? { kind: 'verified', body: { verified: true } } : { kind: state.account }
    }
    return { kind: 'verified', body: { verified: true } }
  }),
  accountVaultIds: vi.fn(() => []),
}))
vi.mock('./tradeRead', async (actual) => {
  const real = await actual<typeof import('./tradeRead')>()
  const cfg = await import('./tradeConfig')
  return {
    ...real,
    readBoard: vi.fn(async () => ({
      version: 1, orderTemplate: cfg.TRADE_ORDER_TEMPLATE, quote: cfg.TRADE_QUOTE, feeBps: 100n, caravelPct: 70n,
      caravelAccount: cfg.TRADE_CARAVEL_FEE_ACCOUNT, burnWallet: cfg.TRADE_BURN_WALLET, minOrder: 1_000_000n, paused: false,
      badgeVault: 'vault_' + 'bb'.repeat(32), badge: cfg.TRADE_BOARD_BADGE,
    })),
    readOrder: vi.fn(async () => order),
    orderLegitimacy: vi.fn(() => null),
    checkPayout: vi.fn(async () => ({ ok: true, outputId: null })),
  }
})
const coins: unknown[] = []
vi.mock('./tradeCoins', async (actual) => ({
  ...(await actual<typeof import('./tradeCoins')>()),
  scanTradeCoins: vi.fn(async () => coins),
  selectLiveCoins: vi.fn(async (c: unknown[]) => ({ inputs: c })),
}))

const cfg = await import('./tradeConfig')
const { prepareCancel, prepareFill, preparePlace, NO_PUBLIC_BALANCE, OrderTaken } = await import('./trade')
const { cancelKeyFor } = await import('./derivation')
const { scanOwnedUtxos } = await import('./stealthUtxos')
const { RESOURCE_HEX } = await import('./utxoFeed')
const { setStoreKey } = await import('./sessionKey')

let order: Record<string, unknown>
const crypto = new WasmStealthCrypto(Network.Esmeralda)
const wallet = SecretKeyWallet.randomWithViewKey(Network.Esmeralda)
const tradeRoot = new Uint8Array(32).fill(7)
const trader = async () => ({ wallet, address: await wallet.getAddress(), account: ACCOUNT, tradeRoot, knownCusdIds: [] })
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

/** A real 10 TARI coin of this wallet's, as the coin scan hands it to the trade code. */
async function realCoin() {
  const { statement } = await crypto.generateOutputsStatement(
    [createOutput({ destination: await wallet.getAddress(), amount: 10_000_000n, resourceAddress: TARI_RESOURCE_ADDRESS })], null)
  const out = (statement.parsed() as { outputs: { output: { commitment: string; sender_public_nonce: string; encrypted_data: string }; auth: unknown; tag: number }[] }).outputs[0]!
  const row = [out.output.commitment, {
    output: { output: { public_nonce: out.output.sender_public_nonce, encrypted_data: out.output.encrypted_data, minimum_value_promise: 0, viewable_balance: null }, auth: out.auth, tag: out.tag },
    is_frozen: false,
  }]
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ utxos: [row] }), { status: 200 })))
  try {
    const owned = await scanOwnedUtxos(crypto, await wallet.getViewSecret())
    expect(owned.map(o => o.substateId)).toEqual([`utxo_${RESOURCE_HEX}_${out.output.commitment}`])
    return owned
  } finally {
    vi.unstubAllGlobals()
  }
}

/** The last transaction signed, as JSON — the instructions and inputs the network is asked to run. */
const lastPriced = () => JSON.stringify(signed.at(-1), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
const declares = (json: string, id: string) => new RegExp(`"substate_id":"${id}"`).test(json)

beforeEach(async () => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    get length() { return store.size }, clear: () => store.clear(), key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => { store.delete(k) }, setItem: (k: string, v: string) => { store.set(k, v) },
  } as Storage
  setStoreKey(new Uint8Array(32).fill(5))
  priced.length = 0
  signed.length = 0
  state.account = 'absent'
  coins.length = 0
  coins.push(...await realCoin())
  order = {
    id: ORDER_ID, version: 3, template: cfg.TRADE_ORDER_TEMPLATE, side: cfg.BUY, status: cfg.ORDER_OPEN,
    board: cfg.TRADE_BOARD_ADDRESS, badge: cfg.TRADE_BOARD_BADGE, quote: cfg.TRADE_QUOTE,
    n: 1_000_000n, p: 1_000_000n, fee: 10_000n, caravelCut: 7_000n, burnCut: 3_000n,
    caravelAccount: cfg.TRADE_CARAVEL_FEE_ACCOUNT, burnWallet: cfg.TRADE_BURN_WALLET,
    payoutStatement: null, payoutAccount: MAKER_PAYOUT, escrowVault: 'vault_' + 'ee'.repeat(32),
    cancelKeyHex: hex(await cancelKeyFor(tradeRoot, 0).getPublicKey()),
  }
})

describe('RECEIVING into a public account that does not exist yet: the trade creates it', () => {
  it('a fill with "receive public" deposits through CreateAccount and never declares the missing component', async () => {
    const p = await prepareFill(await trader(), { orderId: ORDER_ID, expectedN: 1_000_000n, expectedP: 1_000_000n, pay: 'private', receive: 'public' })
    const tx = lastPriced()
    expect(tx).toMatch(/"CreateAccount":\{"owner_public_key":"[0-9a-f]{64}","owner_rule":null,"access_rules":null,"bucket_workspace_id":\{"id":\d+,"offset":null\}\}/)
    expect(tx).not.toMatch(new RegExp(`"call":\\{"Address":"${ACCOUNT}"\\},"method":"deposit"`))
    expect(declares(tx, ACCOUNT)).toBe(false)
    // Permissionless on default rules: the private fill stays private — the owner key does not sign.
    expect(p.ownerSigned).toBe(false)
    expect(p.details.createsAccount).toBe(true)
    expect(p.fee).toBe(20_200n)   // the priced cost + the main-intent buffer: shown = charged
  })

  it('a placement paid out to public creates the account first and names it, without declaring it', async () => {
    order = { ...order }
    const p = await preparePlace(await trader(), { side: cfg.SELL, n: 1_000_000n, p: 1_000_000n, escrow: 'private', payout: 'public', cancelIndex: 0 })
    const tx = lastPriced()
    expect(tx).toMatch(/"CreateAccount":\{"owner_public_key":"[0-9a-f]{64}","owner_rule":null,"access_rules":null,"bucket_workspace_id":null\}/)
    expect(tx.indexOf('"CreateAccount"')).toBeLessThan(tx.indexOf('"place_sell_public"'))
    expect(declares(tx, ACCOUNT)).toBe(false)
    expect(p.details.createsAccount).toBe(true)
  })

  it('an account that EXISTS is declared and deposited into — never re-created into a throwaway', async () => {
    state.account = 'verified'
    const p = await prepareFill(await trader(), { orderId: ORDER_ID, expectedN: 1_000_000n, expectedP: 1_000_000n, pay: 'private', receive: 'public' })
    const tx = lastPriced()
    expect(tx).not.toContain('"CreateAccount"')
    expect(tx).toMatch(new RegExp(`"call":\\{"Address":"${ACCOUNT}"\\},"method":"deposit"`))
    expect(declares(tx, ACCOUNT)).toBe(true)
    expect(p.details.createsAccount).toBe(false)
  })
})

describe('PAYING from a public account that does not exist: refused before anything is priced', () => {
  const refusesUnpriced = async (run: () => Promise<unknown>) => {
    await expect(run()).rejects.toThrow(NO_PUBLIC_BALANCE)
    expect(priced).toHaveLength(0)
  }

  it('a fill paid from public', async () => {
    await refusesUnpriced(async () => prepareFill(await trader(), { orderId: ORDER_ID, expectedN: 1_000_000n, expectedP: 1_000_000n, pay: 'public', receive: 'private' }))
  })

  it('an order escrowed from public', async () => {
    await refusesUnpriced(async () => preparePlace(await trader(), { side: cfg.SELL, n: 1_000_000n, p: 1_000_000n, escrow: 'public', payout: 'private', cancelIndex: 0 }))
  })

  it('a cancel back to public (the account would pay its fee)', async () => {
    await refusesUnpriced(async () => prepareCancel(await trader(), { orderId: ORDER_ID, cancelIndex: 0, to: 'public' }))
  })

  it('the message is plain, and says what to do', () => {
    expect(NO_PUBLIC_BALANCE).toBe('This wallet has no public balance yet. Make some TARI public first, or choose private.')
  })
})

describe('an account nobody can vouch for is never guessed at', () => {
  it('a public receive with the account unreadable refuses, and creates nothing', async () => {
    state.account = 'unknown'
    await expect(prepareFill(await trader(), { orderId: ORDER_ID, expectedN: 1_000_000n, expectedP: 1_000_000n, pay: 'private', receive: 'public' }))
      .rejects.toThrow(/could not/i)
    expect(priced).toHaveLength(0)
  })

  it('private legs never read the account at all', async () => {
    state.account = 'unknown'
    await prepareFill(await trader(), { orderId: ORDER_ID, expectedN: 1_000_000n, expectedP: 1_000_000n, pay: 'private', receive: 'private' })
    expect(lastPriced()).not.toContain('"CreateAccount"')
  })
})

describe('OrderTaken: the ORDER is gone or changed — nothing else is', () => {
  it('a closed order refuses as OrderTaken, before anything is priced', async () => {
    order = { ...order, status: cfg.ORDER_FILLED }
    await expect(prepareFill(await trader(), { orderId: ORDER_ID, expectedN: 1_000_000n, expectedP: 1_000_000n, pay: 'private', receive: 'private' }))
      .rejects.toBeInstanceOf(OrderTaken)
    order = { ...order, status: cfg.ORDER_CANCELLED }
    await expect(prepareCancel(await trader(), { orderId: ORDER_ID, cancelIndex: 0, to: 'private' })).rejects.toBeInstanceOf(OrderTaken)
    expect(priced).toHaveLength(0)
  })

  it('changed terms are OrderTaken too', async () => {
    await expect(prepareFill(await trader(), { orderId: ORDER_ID, expectedN: 2_000_000n, expectedP: 1_000_000n, pay: 'private', receive: 'private' }))
      .rejects.toBeInstanceOf(OrderTaken)
  })

  it('a missing public account is NOT OrderTaken', async () => {
    const e = await prepareFill(await trader(), { orderId: ORDER_ID, expectedN: 1_000_000n, expectedP: 1_000_000n, pay: 'public', receive: 'private' }).catch((x: unknown) => x)
    expect(e).not.toBeInstanceOf(OrderTaken)
  })
})
