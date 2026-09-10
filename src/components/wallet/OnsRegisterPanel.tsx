//   "Register a name" — the M4 (v2) presentation over the SAME logic.
//
//   RESKIN, NOT REWRITE. The status machine, check(), the two-step estimate-then-confirm register
//   (so a fee is always approved before anything is written), canAct, the policy validation and the
//   busy handling are all untouched. Only the rendering moved onto v2's OnsPanel, so the card
//   matches the rest of the modal.

import { useEffect, useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { validateOnsName, checkOnsAvailable, estimateOnsRegistration, registerOnsName, toOnsName, ownedOnsNames } from '../../crypto/ons'
import { beginEntry, markDegraded, settleEntry } from '../../crypto/journalStore'
import { fetchCreatedUtxoIds } from '../../crypto/txOutputs'
import { NameCard, OnsPanel, type OnsStatus } from './v2/panels'
import { plainError } from './v2/plainError'

type Status = 'idle' | 'checking' | 'available' | 'taken' | 'estimating' | 'confirm' | 'registering' | 'done' | 'error'


export default function OnsRegisterPanel() {
  const { wallet, address, nostrNpub } = useWallet()
  const [name, setName] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const [txId, setTxId] = useState<string | null>(null)
  const [fee, setFee] = useState<bigint | null>(null)

  // ── The card is COLLAPSED until asked ─────────────────────────────────────
  //
  // The design draws this slot as an entry point: a line saying what an @name is, and one control.
  // The registration machine below is unchanged and still lives here — it simply does not occupy
  // the overview until someone reaches for it.
  const [open, setOpen] = useState(false)

  /**
   * The name this wallet already owns, if any.
   *
   * LOOKED UP, NOT REMEMBERED. "Claimed" is a fact about the chain, so a wallet that registered
   * months ago on another device has to be told it already has one rather than being invited to
   * claim again. This is the same read ProfilePanel uses, and it fails soft: an unreachable lookup
   * leaves the card in its unclaimed state, which is the harmless way round — the register flow
   * refuses a taken name anyway.
   */
  const [owned, setOwned] = useState<string | null>(null)
  const [ownedLoading, setOwnedLoading] = useState(true)
  useEffect(() => {
    if (!wallet) { setOwnedLoading(false); return }
    let cancelled = false
    setOwnedLoading(true)
    ownedOnsNames(wallet)
      .then(r => {
        if (cancelled) return
        // ── THE COLLAPSE IS HERE, AND IT BELONGS TO THIS CARD, NOT TO THE READ LAYER ──
        //
        // ownedOnsNames now answers honestly: owns-several, owns-none and an unreachable registry
        // are three distinct results (crypto/ons.ts). NameCard takes one nullable string, so it can
        // carry exactly one of them, and this line is where the rest is thrown away — every name
        // after the first, and the difference between "you own none" and "we could not ask".
        //
        // BEHAVIOUR IS UNCHANGED from before the read layer was fixed, deliberately. Rendering all
        // five states honestly belongs to the CNS overlay that replaces this card; what this stage
        // buys is that the lie is now visible, local, and deletable rather than inherited.
        setOwned(r.ok && r.names?.length ? r.names[0].name : null)
      })
      .catch(() => { /* leaves the card unclaimed — see above */ })
      .finally(() => { if (!cancelled) setOwnedLoading(false) })
    return () => { cancelled = true }
  }, [wallet, status])

  const clean = toOnsName(name)
  const policyErr = clean ? validateOnsName(clean) : null
  const canAct = !!wallet && !!address && !!nostrNpub && !!clean && !policyErr
  const busy = status === 'checking' || status === 'estimating' || status === 'registering'

  function reset(next: Status = 'idle') { setStatus(next); setMsg(null); if (next === 'idle') { setTxId(null); setFee(null) } }

  async function check() {
    if (!clean || policyErr) return
    reset('checking')
    const r = await checkOnsAvailable(clean)
    if (r.error) { setStatus('error'); setMsg(r.error); return }
    setStatus(r.available ? 'available' : 'taken')
    setMsg(r.available ? `@${clean} is available.` : `@${clean} is already registered.`)
  }

  // Step 1: dry-run the registration to learn the real fee, then ask the user to confirm.
  async function beginRegister() {
    if (!canAct || !wallet || !address || !nostrNpub) return
    reset('estimating')
    setMsg(`Estimating the network fee for @${clean}.`)
    const e = await estimateOnsRegistration(wallet, address, clean, nostrNpub)
    if (!e.ok || e.feeMicroTari === undefined) { setStatus('error'); setMsg(e.error ?? 'Could not estimate the fee.'); return }
    setFee(e.feeMicroTari)
    setStatus('confirm')
    setMsg(null)
  }

  // Step 2: on explicit confirmation, submit with the approved budget.
  async function confirmRegister() {
    if (!wallet || !address || !nostrNpub || fee === null) return
    setStatus('registering')
    setMsg(`Writing @${clean} to the Tari network.`)

    // ── JOURNALLED FOR SUBTRACTION, NOT FOR DISPLAY ──
    //
    // A registration spends one confidential UTXO and returns the remainder as a change output at
    // this wallet's own stealth address. That output carries no sender, so a later scan cannot
    // tell it from a payment somebody sent us — and reconciliation would report our own change as
    // money from a stranger. Recording its commitment is what stops that.
    //
    // The entry is also HOW THE txId PERSISTS. It used to live in component state and vanish on
    // unmount, which left nothing to read the output back from if the capture below did not finish.
    const journalId = beginEntry(address, {
      kind: 'ons-register',
      amountMicrotari: null,      // nothing is sent; the fee is the whole cost
      feeMicrotari: null,
      from: 'private',
      to: 'private',              // the change comes straight back to us
      counterparty: { kind: 'self', value: address },
      note: null,
      source: 'local-journal',
      selfOutputIds: null,
    }).entry.id

    const r = await registerOnsName(wallet, address, clean, nostrNpub, fee)
    // ATTEMPTED, not failed. `ok: false` is registerOnsName's own catch block converting a throw
    // (see ons.ts) — so it covers a throw during submission, which proves nothing about whether the
    // registration landed. It also covers a pre-submission policy refusal, where nothing did
    // happen; the panel cannot tell them apart, so it claims the lesser of the two.
    if (!r.ok) {
      settleEntry(address, journalId, { outcome: 'pending' })
      setStatus('error'); setMsg(r.error ?? 'Registration failed.'); return
    }

    settleEntry(address, journalId, {
      outcome: 'committed',
      txId: r.txId ?? null,
      feeMicrotari: r.fee ?? null,
    })
    setStatus('done')
    setTxId(r.txId ?? null)
    setMsg('People can now find you by name.')

    // ── READ BACK WHAT IT CREATED ──
    //
    // The ONS client builds the transaction internally and returns no commitment, so the output is
    // recovered from the transaction result instead — see txOutputs. Deliberately AFTER the UI has
    // been told the registration succeeded: it has, and a slow indexer must not make it look
    // otherwise.
    //
    // A FAILURE HERE IS NOT SILENT AND IS NOT FATAL. The entry stays `selfOutputIds: null`, which
    // `unresolvedOutputs` reads as a hole and reconciliation refuses to classify against — so an
    // unrecorded output cannot become a phantom receive. Because the result stays fetchable, that
    // is repairable rather than permanent, which is why it does not degrade the epoch.
    if (r.txId) {
      const created = await fetchCreatedUtxoIds(r.txId)
      if (created !== null) settleEntry(address, journalId, { outcome: 'committed', selfOutputIds: created })
    } else {
      // Committed with no transaction id: there is nothing left to read the output back FROM, so
      // this hole is permanent rather than repairable. The one case that earns a degradation.
      markDegraded(address)
    }
  }

  // ── PRESENTATION ──
  //
  // The status machine maps onto v2's OnsPanel one state at a time. `canAct` additionally gates on
  // having a wallet, an address and a Nostr key — a name with nothing to point at is not
  // registerable — so a status that would otherwise offer an action falls back to idle when it is
  // false.
  const view: OnsStatus = busy || status === 'done' || status === 'error' || status === 'confirm'
    ? status
    : status === 'available' && !canAct ? 'idle'
    : status

  // Collapsed: the design's entry card. Expanded: the flow that was always here.
  if (!open && status === 'idle') {
    return <NameCard claimedName={owned} loading={ownedLoading} onClaim={() => setOpen(true)} />
  }

  return (
    <OnsPanel
      status={view}
      name={clean}
      policyError={policyErr ?? undefined}
      message={msg ? plainError(msg) : undefined}
      feeMicrotari={fee ?? undefined}
      txId={txId ?? undefined}
      onName={setName}
      onCheck={check}
      onRegister={beginRegister}
      onConfirm={confirmRegister}
      onReset={() => { reset('idle'); setOpen(false) }}
      onCopyTx={t => { navigator.clipboard.writeText(t).catch(() => {}) }}
    />
  )
}
