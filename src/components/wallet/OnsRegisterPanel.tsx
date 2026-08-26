//   "Register a name" — the M4 (v2) presentation over the SAME logic.
//
//   RESKIN, NOT REWRITE. The status machine, check(), the two-step estimate-then-confirm register
//   (so a fee is always approved before anything is written), canAct, the policy validation and the
//   busy handling are all untouched. Only the rendering moved onto v2's OnsPanel, so the card
//   matches the rest of the modal.

import { useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { validateOnsName, checkOnsAvailable, estimateOnsRegistration, registerOnsName, toOnsName } from '../../crypto/ons'
import { OnsPanel, type OnsStatus } from './v2/panels'
import { plainError } from './v2/plainError'

type Status = 'idle' | 'checking' | 'available' | 'taken' | 'estimating' | 'confirm' | 'registering' | 'done' | 'error'


export default function OnsRegisterPanel() {
  const { wallet, address, nostrNpub } = useWallet()
  const [name, setName] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const [txId, setTxId] = useState<string | null>(null)
  const [fee, setFee] = useState<bigint | null>(null)

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
    const r = await registerOnsName(wallet, address, clean, nostrNpub, fee)
    if (!r.ok) { setStatus('error'); setMsg(r.error ?? 'Registration failed.'); return }
    setStatus('done')
    setTxId(r.txId ?? null)
    setMsg('People can now find you by name.')
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
      onReset={() => reset('idle')}
      onCopyTx={t => { navigator.clipboard.writeText(t).catch(() => {}) }}
    />
  )
}
