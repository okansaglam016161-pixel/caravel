//   Renders the platform icon set from public/favicon.svg, and the OG card from scripts/og-card.svg.
//
//   ── ONE SOURCE, RASTERISED — NOT A SECOND EXPORT ────────────────────────────
//
//   favicon.svg already IS the tile composition: the brand blue, the small-grade sail, the 22.5%
//   radius and the 108.2% bleed, all derived from the design's own ratios. Exporting the PNGs from
//   the design tool instead would give a second origin for the same artwork, and two origins for
//   one mark is how a favicon and a home-screen icon end up subtly different. So the SVG is the
//   source and these are renders of it. Change the mark, re-run this, and every size follows.
//
//   Run: npm run icons
//
//   THE DEPENDENCY IS DEV-ONLY AND DELIBERATE. @resvg/resvg-js is a binding to resvg, which renders
//   paths without needing a browser or a system library — there is no rasteriser on a stock macOS
//   or CI box, so a script that assumed one would work here and fail there. It ships nothing to
//   users; it exists so the icons can be regenerated rather than hand-maintained.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(HERE, '..', 'public')
const SOURCE = join(PUBLIC, 'favicon.svg')

/**
 * What each size is for. The two favicon PNGs are a FALLBACK, not a duplicate: an SVG favicon is
 * the primary and every current browser prefers it, but older Safari in particular wants a raster,
 * and the cost here is a few hundred bytes.
 */
const SIZES = [
  { file: 'apple-touch-icon.png', size: 180 },  // iOS home screen. PNG is not optional there.
  { file: 'icon-192.png', size: 192 },          // manifest / Android home screen
  { file: 'icon-512.png', size: 512 },          // manifest / Android splash
  { file: 'favicon-32.png', size: 32 },         // raster fallback for the tab
  { file: 'favicon-16.png', size: 16 },         // the same, at the smaller tab size
]

const svg = readFileSync(SOURCE)

for (const { file, size } of SIZES) {
  // fitTo width, not zoom: the source is square, so one number fixes both dimensions and the
  // renders cannot drift out of square if the viewBox is ever edited.
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  writeFileSync(join(PUBLIC, file), png)
  console.log(`  ${file.padEnd(22)} ${size}x${size}  ${png.length} bytes`)
}

//   ── THE SOCIAL CARD ─────────────────────────────────────────────────────────
//
//   Same principle, different source. og-card.svg is the 1200x630 composition with its text already
//   baked to outlines — resvg has no webfont loader, and given a font it cannot find it substitutes
//   Helvetica silently rather than failing, so a card built from <text> would ship the wrong face
//   and still look plausible. Outlines take the font out of the render entirely.
//
//   Only the PNG ships: scrapers want a raster at a declared size and several will not read SVG.

const OG_SOURCE = join(HERE, 'og-card.svg')
const OG = { file: 'og-image.png', width: 1200, height: 630 }

const ogSvg = readFileSync(OG_SOURCE)
const ogPng = new Resvg(ogSvg, { fitTo: { mode: 'width', value: OG.width } }).render().asPng()
writeFileSync(join(PUBLIC, OG.file), ogPng)
console.log(`  ${OG.file.padEnd(22)} ${OG.width}x${OG.height}  ${ogPng.length} bytes`)
