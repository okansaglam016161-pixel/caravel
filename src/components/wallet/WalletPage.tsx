//   The wallet as a PAGE, for the service shell.
//
//   ── WHY THIS IS FOUR LINES AND NOT A SECOND WALLET ───────────────────────────
//
//   WalletModal holds every piece of the wallet's presentation logic: the send and move step
//   machines, the MAX exact-bigint rails, the settle reactions, the E2 account-address gate, the
//   derivation that turns all of it into v2 props. None of that is about being a modal.
//
//   So the page does not reimplement any of it. WalletModal grew one prop — `chrome` — that says
//   whether to wrap itself in a backdrop or hand back its body bare. Both surfaces therefore run
//   the SAME component instance shape, and a fix to either lands in both. The alternative was
//   lifting ~700 lines into a shared hook, which is the right move eventually and exactly the wrong
//   move while the reskin has not started.
//
//   STAGE 1 SCOPE: this is the existing modal body, unstyled to the new page design, sitting in the
//   shell instead of over it. The portfolio layout — vault hero, assets list, extras — is stage 2
//   onward. Nothing here presumes the current 480px column survives that.

import WalletModal from './WalletModal'

export default function WalletPage() {
  return (
    <div style={{
      flex: 1, minWidth: 0, overflowY: 'auto',
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      padding: '28px 24px 40px',
    }}>
      <WalletModal chrome="page" />
    </div>
  )
}
