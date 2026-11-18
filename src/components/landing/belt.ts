// The Ecosystem conveyor belt's timing. The belt moves by exactly one set of cards per cycle (a
// seamless loop), and a set's width changes with the screen (LandingPage's CSS), so the duration is
// derived from the measured width: cards always move at the same speed.

/** The original belt: one set of 3 × (380px + 18px) in 36s. Every belt keeps this speed. */
export const BELT_PX_PER_SECOND = (3 * (380 + 18)) / 36

/** Seconds per cycle for a set this wide (px). Falls back to the original 36s for a bad width. */
export function beltDurationSeconds(setWidthPx: number): number {
  if (!Number.isFinite(setWidthPx) || setWidthPx <= 0) return 36
  return setWidthPx / BELT_PX_PER_SECOND
}
