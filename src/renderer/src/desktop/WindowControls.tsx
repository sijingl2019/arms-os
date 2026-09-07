import { useEffect, useState } from 'react'
import { useShell } from '../i18n/useI18n'
import { Icon } from './icons'

/**
 * The top-right cluster: language, theme, then the window buttons that
 * `frame: false` took away.
 *
 * Language and theme live here rather than buried in Settings because they are
 * display preferences you change on a whim, and the desktop is where you are
 * when you want to.
 *
 * The drag strip is a sibling of these buttons rather than their parent: an
 * `-webkit-app-region: drag` region swallows clicks, so anything interactive
 * has to opt back out, and keeping the two separate makes that impossible to
 * get wrong by nesting.
 */
export function WindowControls(): React.JSX.Element {
  const { t, locale, setLocale, theme, setTheme } = useShell()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // The window can also be maximized by a system gesture - double-clicking
    // the drag strip, Win+Up, edge snap - so follow the window, not our clicks.
    return window.arms.on.windowMaximized(setMaximized)
  }, [])

  return (
    <div className="window-controls">
      <button
        type="button"
        className="win-btn wide"
        title={t('win.language')}
        aria-label={t('win.language')}
        onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
      >
        <Icon name="language" size={14} />
        <span>{locale === 'zh' ? '中' : 'EN'}</span>
      </button>
      <button
        type="button"
        className="win-btn"
        title={t(theme === 'dark' ? 'win.themeToLight' : 'win.themeToDark')}
        aria-label={t(theme === 'dark' ? 'win.themeToLight' : 'win.themeToDark')}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
      </button>

      <span className="win-sep" aria-hidden="true" />

      <button
        type="button"
        className="win-btn"
        title={t('win.minimize')}
        aria-label={t('win.minimize')}
        onClick={() => void window.arms.window.minimize()}
      >
        <Icon name="minimize" size={14} />
      </button>
      <button
        type="button"
        className="win-btn"
        title={t(maximized ? 'win.restore' : 'win.maximize')}
        aria-label={t(maximized ? 'win.restore' : 'win.maximize')}
        onClick={() => void window.arms.window.maximize().then(setMaximized)}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
      </button>
      <button
        type="button"
        className="win-btn danger"
        // Closing hides to the tray; the scheduler keeps running. Quitting is
        // deliberately only available from the tray menu.
        title={t('win.hide')}
        aria-label={t('win.hide')}
        onClick={() => void window.arms.window.close()}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
