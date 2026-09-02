// The picked-image preview shown in the composer before sending (images M5).
//
// Sits in the same slot the payment composer card uses — above the text row — and makes attaching a
// two-step act: pick, look at what you picked, then send. The harness it replaces sent immediately
// on pick, which meant a mis-tap fanned a photo out to a whole group with no way back.
//
// Shared by the DM and group composers, like MessageBubble and PendingBubble. The caption is NOT
// here: both composers already own a textarea, and in attach mode that textarea IS the caption
// field. Duplicating it would give the user two places to type.
//
// ⚠️ THIS IS THE SECOND PLACE IN THE APP THAT MINTS AN OBJECT URL (the first is the resolver hook).
// The same rule applies and for the same reason: THE EFFECT THAT CREATES A URL IS THE EFFECT THAT
// REVOKES IT, with the URL captured in that run's closure. Because the effect is keyed on `file`,
// every exit lands on the same cleanup — Cancel, Send, switching threads, unmounting the composer —
// so none of them can leave a URL behind. Do NOT hoist this into a ref or into the parent's state to
// "avoid recreating it": a URL that outlives the component that owns it leaks for the page's
// lifetime, and picking a dozen photos in a session would leak a dozen.

import { useEffect, useState } from 'react'
import { MONO } from './chatDisplay'

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function AttachPreview({ file, busy, stageLabel, onSend, onCancel }: {
  file: File
  busy: boolean
  // What the pipeline is doing right now ("Preparing…" / "Uploading…" / "Sending…"), or null when
  // idle. Stages rather than a percentage — see describeMediaStage for why that is the honest choice.
  stageLabel: string | null
  onSend: () => void
  onCancel: () => void
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => { URL.revokeObjectURL(url); setPreviewUrl(null) }
  }, [file])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14, background: 'var(--surface-base)', border: '1px solid rgba(var(--teal-500-rgb),0.24)', marginBottom: 12 }}>
      <div style={{ width: 62, height: 62, flexShrink: 0, borderRadius: 10, overflow: 'hidden', background: 'var(--surface-inset)', border: '1px solid var(--border)' }}>
        {previewUrl && <img src={previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-faint-dim)', marginTop: 3 }}>
          {/* The size shown is the ORIGINAL. What actually goes over the wire is smaller — the image
              is downscaled and re-encoded first — so this is not a promise about upload size. */}
          {busy && stageLabel ? stageLabel : `${readableSize(file.size)} · will be resized before sending`}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, fontFamily: 'inherit' }}
        >
          Cancel
        </button>
        <button
          onClick={onSend}
          disabled={busy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 9, border: 'none', background: busy ? 'rgba(var(--border-rgb),0.14)' : 'var(--teal-grad)', color: busy ? 'var(--text-disabled)' : 'var(--ink-on-accent)', fontSize: 12.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }}
        >
          {busy
            ? <span style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(var(--border-rgb),0.3)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite' }} />
            : <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>}
          Send
        </button>
      </div>
    </div>
  )
}
