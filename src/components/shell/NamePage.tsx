//   The Name service.
//
//   STAGE 1 SCOPE — a real slot, not a placeholder. The nav needs three working destinations, and
//   @name registration already works: OnsRegisterPanel owns the check → estimate → confirm →
//   register machine over crypto/ons.ts, and it is mounted here as it stands.
//
//   It is ALSO still mounted inside the wallet overview's extras slot, which is intentional for
//   now: the two instances hold separate local state, neither is authoritative, and removing the
//   overview copy is stage 7's job — the stage that reskins this service properly and decides
//   where the entry point belongs. Moving it early would take a working control away from the
//   surface people currently use, to no benefit.

import OnsRegisterPanel from '../wallet/OnsRegisterPanel'

export default function NamePage() {
  return (
    <div style={{
      flex: 1, minWidth: 0, overflowY: 'auto',
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      padding: '28px 24px 40px',
    }}>
      <div style={{ width: 'min(480px, 94vw)', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h1 style={{
          margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em',
          color: 'var(--text-primary)',
        }}>Name</h1>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-muted-dim)' }}>
          Claim an @name on the Ootle. One identity for payments and messages.
        </p>
        <OnsRegisterPanel />
      </div>
    </div>
  )
}
