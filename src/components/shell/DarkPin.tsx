//   A temporary dark lock for surfaces the reskin has not reached.
//
//   ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
//   Light is now the app's default theme, and most surfaces follow it. Chat does not: it holds
//   dark-only literals throughout — gradients, rgba washes, hand-picked hex — so on a light ground
//   it renders pale text on pale surfaces.
//
//   So it is pinned to dark until its redesign. A dark island inside a light app is a deliberate,
//   legible in-between state. A half-light screen is a bug.
//
//   ── HOW TO REMOVE ONE ────────────────────────────────────────────────────────
//
//   Delete the <DarkPin> wrapper around that surface and verify it in both themes. That is the
//   whole procedure; nothing else is holding it. The list of what is still pinned is the list of
//   places this component appears, which `grep DarkPin src` answers in full.
//
//   ── WHAT IS PINNED, AND WHEN IT LIFTS ────────────────────────────────────────
//
//     Chat pane .......... the chat redesign
//
//   CHAT IS THE LAST ONE. The create / unlock / restore gates un-pinned when their backdrop stopped
//   being a navy-scale gradient, and the profile panel un-pinned when stage 10 reskinned it. When
//   chat's redesign lands, this component has no callers left and should be deleted with it.
//
//   The in-chat wallet modal is NOT pinned separately, and inherits chat's pin because it renders
//   inside chat's tree. That is correct rather than incidental: it floats over the conversation, so
//   a light modal on a dark thread would look like the bug this component exists to prevent. It
//   un-pins with chat.

import type { ReactNode } from 'react'

export default function DarkPin({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return <div data-theme="dark" style={style}>{children}</div>
}
