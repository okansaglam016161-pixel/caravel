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
//   ── THE PAGE IS THE SCROLLER ─────────────────────────────────────────────────
//
//   This container scrolls and the wallet inside it does not. Until the layout pass the page
//   rendered a 480 modal column — height-capped and internally scrolling — inside this already
//   scrolling pane, which is two scrollbars for one list. `chrome="page"` drops the card, the
//   height cap and the inner scroller; what is left is content in a column.
//
//   WIDTH IS CAPPED, NOT UNLIMITED. It fills the pane up to PAGE_MAX_WIDTH and centres beyond it.
//   The design's proportions come from a 1280 shell with a 224 nav beside it; past roughly that the
//   vault stops reading as a card and an assets row puts half a screen between a name and its
//   amount. Below the cap it is fully fluid, so narrowing the window reflows rather than clipping.

import WalletModal from './WalletModal'
import { PAGE_MAX_WIDTH } from './v2/tokens'

export default function WalletPage() {
  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
      <div style={{
        maxWidth: PAGE_MAX_WIDTH, margin: '0 auto',
        padding: 'clamp(16px, 3vw, 32px) clamp(16px, 3vw, 32px) 48px',
      }}>
        <WalletModal chrome="page" />
      </div>
    </div>
  )
}
