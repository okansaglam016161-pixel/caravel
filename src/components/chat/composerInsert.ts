// Insert-at-cursor for the two composers (emoji picker, B) — pure, so the rule lives in one place
// and is testable. The sibling of messageEdit.ts / replyCompose.ts, and kept out of the views for
// the same reason: the DM composer and the group composer would otherwise implement this twice and
// drift. Nothing here touches React, the DOM, the store or the wire.
//
// WHY THIS IS NOT ONE LINE OF `draft + char`. Both textareas are CONTROLLED (`value={draft}`), so
// the caret is not the caller's to assume: the user may have clicked into the middle of a half-typed
// message, or selected a word. Appending would silently move an emoji they placed mid-sentence to
// the end. The caret this returns is what the view must restore AFTER React commits the new value —
// see the pendingCaret note in ChatApp/GroupThread, and F8.

export interface InsertResult {
  text: string
  // Where the caret must be put once `text` has been committed: immediately after the inserted run.
  caret: number
}

// Clamp a textarea selection offset into the string. `selectionStart`/`selectionEnd` are typed
// `number | null` and are null for input types that have no selection, so a missing or nonsensical
// value degrades to "the end of the text" — i.e. an append, which is the safe reading of "we do not
// know where the cursor is".
function clampOffset(value: number | null | undefined, len: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return len
  return Math.min(Math.max(Math.floor(value), 0), len)
}

// Splice `insert` into `text` at the current selection, returning the new text and where the caret
// belongs. A non-empty selection is REPLACED, which is what typing a character would do — an emoji
// picked while a word is highlighted should behave like any other keystroke.
//
// `maxLen` is enforced HERE and nowhere else, because the textarea's own `maxLength` attribute does
// not apply to programmatic writes: it gates typing and paste only, so without this check the
// picker would be the one way to push a draft past the limit the counter is displaying (F9). An
// insert that would overflow is a NO-OP — the original text comes back unchanged, and the caret is
// returned to where the selection already was, so a refused insert never also moves the cursor.
// Truncating the emoji instead is not an option: half a surrogate pair is not a character.
export function insertAtCursor(
  text: string,
  selStart: number | null | undefined,
  selEnd: number | null | undefined,
  insert: string,
  maxLen: number
): InsertResult {
  const a = clampOffset(selStart, text.length)
  const b = clampOffset(selEnd, text.length)
  const start = Math.min(a, b)
  const end = Math.max(a, b)

  if (insert.length === 0) return { text, caret: end }

  // .length is UTF-16 code units — the same unit maxLength counts in, and the same unit the
  // character counter under the composer displays, so the three can never disagree.
  if (text.length - (end - start) + insert.length > maxLen) return { text, caret: end }

  return {
    text: text.slice(0, start) + insert + text.slice(end),
    caret: start + insert.length,
  }
}
