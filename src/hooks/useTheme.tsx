//   The app-wide theme.
//
//   ── HOW IT APPLIES ───────────────────────────────────────────────────────────
//
//   `data-theme` goes on <html>, and src/index.css matches both values there:
//   `:root[data-theme="light"]` and `:root, [data-theme="dark"]`. Setting the attribute therefore
//   re-declares the role tokens for the whole document — every route, including the gate screens,
//   which render outside the app shell. Any subtree can still override it, which is what the
//   remaining dark PINS rely on (see DarkPin).
//
//   ── WHY A PROVIDER RATHER THAN A HOOK PER CALLER ─────────────────────────────
//
//   Three places now need this at once: the root, to apply it; the wallet header, to toggle it; and
//   the landing page, whose own toggle used to hold a SEPARATE copy of the same state writing the
//   same storage key. Two independent states over one preference is how a toggle ends up disagreeing
//   with the page it is toggling. One provider, one writer.
//
//   ── LIGHT IS THE DEFAULT ─────────────────────────────────────────────────────
//
//   The foundation is light-first. Dark is a complete, first-class theme and one click away, but it
//   is the opt-in now rather than the only option.
//
//   The choice persists under 'caravel-theme', so a visitor who picks dark on the landing page is
//   still in dark at the unlock screen and in the wallet behind it.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark'

const THEME_KEY = 'caravel-theme'
const DEFAULT_THEME: Theme = 'light'

function readStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === 'light' || t === 'dark' ? t : DEFAULT_THEME
  } catch {
    // Private mode / blocked storage. Not worth surfacing — take the default.
    return DEFAULT_THEME
  }
}

interface ThemeCtx {
  theme: Theme
  setTheme: (t: Theme) => void
  toggleTheme: () => void
}

const Ctx = createContext<ThemeCtx | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* blocked storage — the pick just won't persist */ }
  }, [theme])

  const value = useMemo<ThemeCtx>(() => ({
    theme,
    setTheme,
    toggleTheme: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')),
  }), [theme])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * Read and change the theme.
 *
 * Returns a no-op toggle outside a provider rather than throwing. The wallet renders in the dev
 * preview harness as well as in the app, and a marketing-page component that cannot be mounted
 * without a theme provider would be a worse trade than a control that quietly does nothing in a
 * harness that has no theme to change.
 */
export function useTheme(): ThemeCtx {
  return useContext(Ctx) ?? { theme: DEFAULT_THEME, setTheme: () => {}, toggleTheme: () => {} }
}
