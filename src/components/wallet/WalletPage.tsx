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
//   ── THE WALLET FILLS ITS PAGE ────────────────────────────────────────────────
//
//   The column is FLUID. It takes whatever width the spine leaves it, and the only thing between
//   the content and the pane is this padding — which clamps, so a phone gets 16 and a desktop 32
//   rather than a percentage that reads as a margin at one size and a hairline at another.
//
//   PAGE_MAX_WIDTH IS A CEILING, NOT A MEASURE. It exists for the 2560 and 3840 case and is set
//   high enough that ordinary screens never reach it: a 1440, a 1512 and a 1728 viewport are all
//   narrower than the cap once the spine is taken off, so on those the wallet is simply full width.
//   `margin: '0 auto'` is what the ceiling needs to be worth having — past it the column centres
//   instead of hugging the spine. Below it the margin resolves to zero and does nothing.
//
//   This page ran at 770 for one pass — the design's own column, drawn beside a 210 nav — and the
//   verdict on seeing it was that the wallet should own its page rather than sit in a card-shaped
//   margin of it. What the design still governs is everything inside the column.

import WalletModal from './WalletModal'
import { PAGE_MAX_WIDTH } from './v2/tokens'

export default function WalletPage() {
  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
      <div style={{
        width: '100%', maxWidth: PAGE_MAX_WIDTH, margin: '0 auto', boxSizing: 'border-box',
        padding: 'clamp(16px, 3vw, 32px) clamp(16px, 3vw, 32px) 48px',
      }}>
        <WalletModal chrome="page" />
      </div>
    </div>
  )
}
