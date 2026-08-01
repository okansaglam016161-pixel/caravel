//   StatusPill — transaction/state badge built on Chip.
//   confirmed (teal) · pending (warn) · not-confirmed (warn, distinct label) · failed (danger).
//   'not-confirmed' is used by the Activity list and the timeout banner — warn-toned, distinct
//   from the danger-toned 'failed'.

import Chip from './Chip'
import type { CSSProperties } from 'react'

export type TxStatus = 'confirmed' | 'pending' | 'not-confirmed' | 'failed'

const MAP: Record<TxStatus, { tone: 'teal' | 'warn' | 'danger'; label: string }> = {
  confirmed: { tone: 'teal', label: 'Confirmed' },
  pending: { tone: 'warn', label: 'Pending' },
  'not-confirmed': { tone: 'warn', label: 'Not confirmed' },
  failed: { tone: 'danger', label: 'Failed' },
}

interface StatusPillProps {
  status: TxStatus
  /** Override the default label (e.g. "Rejected"). */
  label?: string
  style?: CSSProperties
}

export default function StatusPill({ status, label, style }: StatusPillProps) {
  const { tone, label: dflt } = MAP[status]
  return <Chip tone={tone} style={style}>{label ?? dflt}</Chip>
}
