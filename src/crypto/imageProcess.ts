// Prepare a picked image for sending (M2): downscale to chat size, strip metadata, re-encode.
// Runs BEFORE encryption — mediaCrypto never sees the original file.
//
// ── EXIF IS HANDLED, AND BOTH HALVES MATTER FOR A PRIVACY APP ────────────────────
//
// ORIENTATION: `imageOrientation: 'from-image'` makes createImageBitmap return the bitmap ALREADY
// rotated per the EXIF orientation flag, so the dimension math and the canvas draw both see the
// image as the user sees it. Without it, every portrait phone photo arrives sideways. Doing it by
// hand — reading the orientation byte and applying one of eight canvas transforms — is the usual
// version of this bug and is unnecessary.
//
// METADATA STRIPPING is free and total, and is the reason to re-encode even when a photo is already
// small enough. Canvas re-encoding builds a new file from raw PIXELS, so GPS coordinates, capture
// timestamps, device model and serial numbers simply do not survive — no EXIF parser, nothing to
// miss. Phone photos routinely carry home addresses in them; for this app that is the point.
// (Some Blossom hosts reject uploads containing GPS metadata outright. We never send any.)

// Longest edge after downscaling. A 1600px image is sharp on a retina chat bubble and typically
// lands at 200-500KB — a size worth sending over a best-effort relay path.
export const MAX_EDGE_PX = 1600
// Reject before decoding. A 48MP photo decodes to ~190MB of RGBA before any downscale, which is
// where mobile Safari runs out of memory; refusing early gives a clear message instead of a dead tab.
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024
// Encoded-size target. Missing it costs one lower-quality re-encode, not a search loop.
const TARGET_BYTES = 600 * 1024
const QUALITY = 0.82
const QUALITY_RETRY = 0.62

export interface ProcessedImage {
  bytes: ArrayBuffer
  mime: string        // the PRE-ENCRYPTION type → kind 15's `file-type`
  width: number
  height: number
}

export class ImageTooLargeError extends Error {
  // Declared explicitly rather than as a constructor parameter property: the app's tsconfig sets
  // `erasableSyntaxOnly`, which forbids the shorthand (it emits runtime code rather than erasing).
  readonly bytes: number
  constructor(bytes: number) {
    super(`Image is ${(bytes / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_SOURCE_BYTES / 1024 / 1024}MB`)
    this.name = 'ImageTooLargeError'
    this.bytes = bytes
  }
}

// Fit (srcW × srcH) inside a maxEdge box, preserving aspect ratio. NEVER upscales — a 900px source
// stays 900px, because inventing pixels only costs bytes.
//
// Extracted and exported purely so it can be unit-tested: this is where the bugs in a downscale
// live (aspect rounding, portrait vs landscape, the no-upscale rule), while the canvas call wrapped
// around it is thin and untestable outside a browser.
export function targetDimensions(srcW: number, srcH: number, maxEdge: number): { width: number; height: number } {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    return { width: 0, height: 0 }
  }
  const longest = Math.max(srcW, srcH)
  if (longest <= maxEdge) return { width: Math.round(srcW), height: Math.round(srcH) }
  const scale = maxEdge / longest
  // max(1, …) so an extreme aspect ratio (a 4000×3 banner) can't round its short side to zero,
  // which would make the canvas throw.
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  }
}

// Pick the output format once. WebP is meaningfully smaller than JPEG at equal quality and is
// supported by every browser we target; JPEG is the fallback for anything that refuses to encode it.
async function encode(canvas: HTMLCanvasElement, quality: number): Promise<{ blob: Blob; mime: string }> {
  const webp = await canvasToBlob(canvas, 'image/webp', quality)
  // A browser that can't encode WebP may either reject or silently hand back a PNG — check the type
  // it actually produced rather than trusting that no error means success.
  if (webp && webp.type === 'image/webp') return { blob: webp, mime: 'image/webp' }
  const jpeg = await canvasToBlob(canvas, 'image/jpeg', quality)
  if (jpeg) return { blob: jpeg, mime: 'image/jpeg' }
  throw new Error('Could not encode the image')
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality))
}

// Downscale, strip metadata, re-encode. Returns the bytes to encrypt.
export async function processImage(file: Blob): Promise<ProcessedImage> {
  if (file.size > MAX_SOURCE_BYTES) throw new ImageTooLargeError(file.size)

  // 'from-image' applies the EXIF orientation during decode — see the note at the top.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const { width, height } = targetDimensions(bitmap.width, bitmap.height, MAX_EDGE_PX)
    if (width === 0 || height === 0) throw new Error('Image has no dimensions')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D canvas context')
    // Best-quality resampling; the difference is visible on a photo scaled by 3-4x.
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)

    let { blob, mime } = await encode(canvas, QUALITY)
    // One retry at lower quality if we overshot. Deliberately a single step: a binary search over
    // quality would cost several full re-encodes to save a few KB nobody notices.
    if (blob.size > TARGET_BYTES) {
      const retry = await encode(canvas, QUALITY_RETRY)
      if (retry.blob.size < blob.size) ({ blob, mime } = retry)
    }

    return { bytes: await blob.arrayBuffer(), mime, width, height }
  } finally {
    // Release the decoded bitmap promptly rather than waiting for GC. On mobile this is the
    // difference between sending several photos in a row and running out of memory on the third.
    bitmap.close()
  }
}
