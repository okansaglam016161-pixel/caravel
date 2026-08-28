//   The light/dark control.
//
//   ONE COMPONENT, EVERY SURFACE. It began life inline in the landing page's top bar; the wallet
//   header needs the same control, and two hand-kept copies of a toggle is how they end up drawing
//   different icons for the same state. This is that button, lifted verbatim.
//
//   IT NAMES THE DESTINATION, NOT THE STATE — a moon while you are in light. That is the reading
//   people apply to a control which changes its own appearance the moment it is pressed.
//
//   `size` exists so it can sit at 36 in the landing's top bar and at 30 beside the wallet's
//   hide-balance eye without either row looking mismatched. Same component, same icons, same
//   behaviour; only the box it fills differs.
//
//   THE BOX ITSELF IS SHARED — see primitives/iconBox. The wallet header sets two more controls
//   beside this one, and the row only reads as one control repeated if all three take their
//   geometry from the same place.

import { useTheme } from '../../hooks/useTheme'
import { iconBoxStyle } from './iconBox'

const Sun = ({ px }: { px: number }) => (
  <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)

const Moon = ({ px }: { px: number }) => (
  <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
)

export default function ThemeToggle({ size = 36 }: { size?: number }) {
  const { theme, toggleTheme } = useTheme()
  const dark = theme === 'dark'
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme'

  return (
    <button
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className="cv-icon-btn"
      style={iconBoxStyle(size)}
    >{dark ? <Sun px={Math.round(size * 0.44)} /> : <Moon px={Math.round(size * 0.44)} />}</button>
  )
}
