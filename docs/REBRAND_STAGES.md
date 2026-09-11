# Rebrand — stage numbering

The `rebrand-design-system` branch is being landed in numbered stages, one commit each. The numbers
appear in commit subjects (`… (logo L4)`) and nowhere else, which is how a lost session nearly cost
us the ordering once already. This file is the record. Keep it current when a stage lands.

Source of truth for the artwork is the **"Caravel design system foundation"** project on
claude.ai/design (`2ceef0a3-84a3-475d-9e6b-a5155dad174f`) — the `Caravel Logo`, `Caravel OG Card`
and `Caravel X Banner` pages. Read the design as the source; do not re-implement its HTML.

## The rule these stages follow

One source, rasterised — never a second export. `public/favicon.svg` and `scripts/og-card.svg` are
the compositions; every PNG is a render of one of them via `npm run icons`. Exporting the same
artwork a second time from the design tool is how a favicon and a home-screen icon end up subtly
different from each other a year later.

## Landed

| Stage | Commit | What |
|-------|--------|------|
| L1 | `05c2de0` | The new mark drawn as geometry, in two grades (detailed + small). |
| L2 | `3122973` | `LogoTile` component; the mark placed on its four surfaces. |
| L3 | `d8ca0b8` | Tab icon becomes the new sail as geometry — small grade, the one case that drops the seam. |
| L4 | `b74ef0d` | Platform icon set + `site.webmanifest`, rasterised from `favicon.svg` by `scripts/make-icons.mjs`. |
| L5 | `d2f2a68` | The 1200×630 OG / link-preview card, drawn and wired into the head. |
| L6 | `9993853` | Deleted the old mark's assets and an unused social sprite. (Landed out of order, ahead of L5.) |

## L5 — social OG / link-preview card

Landed as `d2f2a68`.

- `scripts/og-card.svg` — the 1200×630 card as geometry: brand blue `#378ADD`, the **detailed**
  grade of the sail (the seam is present, unlike the favicon's small grade), "Caravel", and the
  tagline. Layout reproduces the design's flexbox arithmetically; baselines come from the face's
  own metrics rather than being eyeballed.
- `public/og-image.png` — the render, produced by `npm run icons`.
- `index.html` — `og:*` and `twitter:*` tags. The image URLs are **absolute**; scrapers do not
  resolve relative ones, they drop them.

**The text is baked to outlines, and it has to be.** resvg has no webfont loader. Given
`font-family: Instrument Sans` on a machine without it installed — which is every machine here, it
is a Google font — it does not fail, it silently substitutes Helvetica and produces a card that
looks fine until you hold it next to the brand. Outlines remove the font from the render entirely.

Two traps worth leaving written down, both hit during L5:

1. **opentype.js `toPathData()` emits `NaN`.** A coordinate landing on a trailing-zero integer
   (`780.0000000000001`) serialises as the literal string `NaN`; resvg treats that as a parse error
   and silently drops *the rest of the path*. It rendered as `A Swiss Ba`. The path commands
   themselves are always finite, so serialise them directly instead of trusting `toPathData`.
2. **A card with broken text is worse than no card**, and byte-count checks do not catch either
   trap — both produce a plausible PNG of the right size. Rasterise and *look* at it.

Regenerating the outlines, if the copy or the type ever changes: Instrument Sans SemiBold (weight
600, Google Fonts v4), converted with opentype.js at the design's own values — name 30px /
letter-spacing .01em, tagline 62px / letter-spacing −.02em / line-height 1.14, column gap 22px,
kerning applied per pair. The two tagline lines are where a 630px column breaks that sentence,
which is what the design's `text-wrap: balance` resolves to.

## L7 — the teal rename (cosmetic alias cleanup)

Done, uncommitted as of this writing.

Purely cosmetic: rename the surviving `teal*` identifiers. **Nothing teal is left in the product** —
the accent moved from teal `#2DE0C6` to cobalt `#378ADD` at the rebrand, and the colour pass was
deliberately kept reviewable by aliasing the old key names rather than doing a 296-site rename in
the same commit. `src/index.css` already finished its half: the `--teal-*` / `--acc*` custom
properties were deleted once every consumer was gone, and nothing in `src` names a teal-era CSS
token.

What remains is the wallet v2 module, where the names are still teal-era even though every value
behind them resolves to a cobalt token. `src/components/wallet/v2/tokens.ts` is explicit about it
("`teal*` names kept as deprecated aliases — nothing here is teal any more"):

- `C.teal`, `C.teal300`, `C.tealGradTop`, `C.tealGradBottom`, `C.inkOnTeal`, `C.tealLabel`,
  `C.tealDim` → `var(--accent-*)` / `var(--ink-on-accent)` / `var(--text-*)`
- the helpers `tealBorder(a)` and `tealFill(a)` → `rgba(var(--accent-400-rgb), a)`
- `'teal'` as a member of the `PanelTone` union and of `AmountField`'s `accent` prop

Consumers to update alongside the definitions: `tokens.ts`, `primitives.tsx`, `move.tsx`, and
`src/dev/WalletPreview.tsx`.

### What was done

`accent` was the right target name rather than anything invented: `panels.tsx` already ships
`<Emblem tone="accent">`, so the vocabulary existed.

- `C.teal` → `C.accent`, `C.teal300` → `C.accent300`, `C.inkOnTeal` → `C.inkOnAccent`,
  `C.tealDim` → `C.accentDim`
- `tealBorder()` → `accentBorder()`, `tealFill()` → `accentFill()`
- `PanelTone`'s `'teal'` → `'accent'`; `AmountField`'s `accent` prop union and default likewise,
  and its local `const teal` → `isAccent`
- three comments that named the *current* vocabulary ("the teal/amber split", "teal only on the
  selection") followed the rename. Comments describing HISTORY ("it was a teal gradient until V3")
  were left alone — they are accurate, and rewriting them would erase the record.

**Three aliases were dropped, not renamed**, because all three were already dead with zero
consumers: `tealGradTop`, `tealGradBottom` (they named the retired brand gradient) and `tealLabel`.
A renamed dead token is still dead. They were object properties on `C`, so unlike unused functions
they were NOT tree-shaken and really did ship — removing them shrank the bundle.

### The gradient

`SettleBar`'s `linear-gradient(90deg, tealFill(0.15), C.teal)` was collapsed to a flat `C.accent`,
which is what the "never teal, never gradients" rule asks for. **It renders nowhere**: `SettleBar`
has zero call sites in the repo, and neither `linear-gradient(90deg` nor its `cv-slide` animation
appears in the production bundle before OR after — it is tree-shaken out entirely. So even this,
the one semantic change in the stage, moves no pixel. `SettleBar` is dead code and is a candidate
for a future sweep; L7 deliberately left that decision alone.

### Proving zero rendered change

A screenshot diff was not available, so the check was done on the build output instead, which is
stronger:

- every resolved token value is byte-identical across the rename (each `teal*` and its `accent*`
  replacement resolve to the same `var(--…)` string)
- `dist/assets/index-*.css` is **byte-identical** between HEAD and L7
- the app bundle differs only in identifier names and the dropped dead properties; `var(--accent-400)`
  occurs 68 times in both
- `dist/index.html` differs only by the bundle's content-hash in its `<script src>`
- brand-`teal` identifiers in the shipped bundle: **9 at HEAD, 0 after**. Every remaining `teal`
  substring (18, unchanged) is inside **`stealth`**

### stealth is untouched

Confirmed: no line of the diff contains `stealth` in any case, and `src/crypto/` is not among the
changed files at all. The trap is real — a case-insensitive search for `teal` matches every
occurrence of `stealth`, which is core protocol vocabulary — so exclude it in any future pass.

Verified: `tsc -b` clean, `oxlint` 9 warnings (identical to HEAD, all pre-existing), 1436 tests pass.
