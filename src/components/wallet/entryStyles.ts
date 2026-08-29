//   What is left of the pre-V3 entry styles.
//
//   The card, the buttons, the field surface, the word chip and the page shell all moved to
//   entryUi.tsx in the V3 pass, as components rather than loose style objects — the three entry
//   screens share markup, not just values, and sharing only the values is how they drifted apart
//   in the first place. PasswordField went with them: its eye toggle is EntryField's now.
//
//   This one constant stays because it is imported by files that need the mono face and nothing
//   else, and re-exporting it through a component module would make those imports lie about why
//   they exist.

export const MONO = 'var(--font-mono)'
