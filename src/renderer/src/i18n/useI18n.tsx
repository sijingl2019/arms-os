import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { format, MESSAGES, type Locale, type MessageKey } from './messages'

/**
 * Language and theme, both switched from the desktop's top-right corner.
 *
 * Persisted in `localStorage` rather than through the main process: ARMS has no
 * writable config store, and these are per-machine display preferences, not
 * part of the OS state that the CLI and the scheduler share.
 */

export type Theme = 'dark' | 'light'

const LOCALE_KEY = 'arms.locale'
const THEME_KEY = 'arms.theme'

interface Shell {
  locale: Locale
  setLocale(next: Locale): void
  theme: Theme
  setTheme(next: Theme): void
  t(key: MessageKey, vars?: Record<string, string | number>): string
}

const ShellContext = createContext<Shell | null>(null)

/** Chinese unless the machine says otherwise; a stored choice always wins. */
function initialLocale(): Locale {
  const stored = readStorage(LOCALE_KEY)
  if (stored === 'zh' || stored === 'en') return stored
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function initialTheme(): Theme {
  const stored = readStorage(THEME_KEY)
  if (stored === 'dark' || stored === 'light') return stored
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** localStorage throws in some contexts; a missing preference is not an error. */
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* a preference that cannot be remembered still applies to this session */
  }
}

export function ShellPreferences({ children }: { children: ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)
  const [theme, setThemeState] = useState<Theme>(() => {
    const initial = initialTheme()
    // Applied before the first paint of the tree below, so nothing flashes.
    document.documentElement.setAttribute('data-theme', initial)
    return initial
  })

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    writeStorage(LOCALE_KEY, next)
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
  }, [])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    writeStorage(THEME_KEY, next)
    // The particle cloud watches this attribute and re-reads its palette.
    document.documentElement.setAttribute('data-theme', next)
  }, [])

  const value = useMemo<Shell>(
    () => ({
      locale,
      setLocale,
      theme,
      setTheme,
      t: (key, vars) => format(MESSAGES[locale][key], vars)
    }),
    [locale, setLocale, theme, setTheme]
  )

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}

export function useShell(): Shell {
  const value = useContext(ShellContext)
  if (!value) throw new Error('useShell must be used inside <ShellPreferences>')
  return value
}
