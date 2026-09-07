import { useRef } from 'react'
import { useShell } from '../i18n/useI18n'
import { WALLPAPERS, type WallpaperFit } from './model'
import { useWallpaper } from './WallpaperProvider'
import './wallpaper.css'

export function WallpaperSettings(): React.JSX.Element {
  const { t, locale } = useShell()
  const wallpaper = useWallpaper()
  const input = useRef<HTMLInputElement>(null)
  const { value, busy, ready, error } = wallpaper
  const disabled = busy || !ready
  const current = WALLPAPERS.find(preset => preset.id === value.presetId) ?? WALLPAPERS[0]

  return <div className="wallpaper-settings">
    <div className="row">
      <h2 className="settings-h">{t('settings.wallpaper')}</h2>
      <span className="spacer" />
      <button type="button" disabled={disabled} onClick={() => void wallpaper.selectPreset('default')}>{t('wallpaper.reset')}</button>
    </div>
    <p className="settings-note">{t('wallpaper.note')}</p>

    <div className="wallpaper-preview" style={wallpaper.style} role="img" aria-label={t('wallpaper.preview')}>
      <div className="preview-widgets" aria-hidden="true"><i /><i /><i /></div>
      <div className="preview-orb" aria-hidden="true" />
      <div className="preview-widgets" aria-hidden="true"><i /><i /><i /></div>
      <div className="preview-dock" aria-hidden="true"><i /><i /><i /><i /><i /></div>
    </div>
    <div className="wallpaper-caption">
      <strong className="ellipsis">{value.mode === 'image' ? value.imageName : current.name[locale]}</strong>
      <span>{t('wallpaper.preview')}</span>
    </div>
    <p className={error ? 'error' : 'settings-note'} role={error ? 'alert' : 'status'}>
      {error ? t(`wallpaper.error.${error}`) : !ready ? t('common.loading') : busy ? t('wallpaper.saving') : t('wallpaper.saved')}
    </p>

    <section>
      <div className="row">
        <button type="button" className={'wallpaper-adaptive' + (value.mode === 'preset' && value.presetId === 'default' ? ' selected' : '')}
          aria-pressed={value.mode === 'preset' && value.presetId === 'default'} disabled={disabled}
          onClick={() => void wallpaper.selectPreset('default')}>
          <span className="adaptive-swatch" style={{ background: WALLPAPERS[0].background }} aria-hidden="true" />
          <span><strong>{WALLPAPERS[0].name[locale]}</strong><small>{t('wallpaper.adaptive')}</small></span>
        </button>
      </div>
    </section>

    {(['solid', 'gradient'] as const).map(kind => <section key={kind}>
      <h3 className="label">{t(`wallpaper.${kind}`)}</h3>
      <div className="wallpaper-grid">
        {WALLPAPERS.filter(preset => preset.kind === kind).map(preset => {
          const selected = value.mode === 'preset' && value.presetId === preset.id
          return <button type="button" key={preset.id} className={'wallpaper-option' + (selected ? ' selected' : '')}
            aria-label={preset.name[locale]} aria-pressed={selected} disabled={disabled}
            onClick={() => void wallpaper.selectPreset(preset.id)}>
            <span className="wallpaper-swatch" style={{ background: preset.background }} aria-hidden="true">
              {selected && <span className="wallpaper-check">✓</span>}
            </span>
            <span>{preset.name[locale]}</span>
          </button>
        })}
      </div>
    </section>)}

    <section>
      <h3 className="label">{t('wallpaper.image')}</h3>
      <p className="settings-note">{t('wallpaper.imageNote')}</p>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={disabled}
        aria-label={t('wallpaper.upload')} onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void wallpaper.upload(file)
        }} />
      <div className="row wallpaper-image-actions">
        <button type="button" className="primary" disabled={disabled} onClick={() => input.current?.click()}>
          {t(value.image ? 'wallpaper.replace' : 'wallpaper.upload')}
        </button>
        {value.image && <>
          {value.mode !== 'image' && <button type="button" disabled={disabled} onClick={() => void wallpaper.useImage()}>{t('wallpaper.useImage')}</button>}
          <button type="button" className="danger" disabled={disabled} onClick={() => void wallpaper.removeImage()}>{t('wallpaper.remove')}</button>
          <span className="muted ellipsis wallpaper-filename">{value.imageName}</span>
        </>}
      </div>
      {value.image && <div className="settings-row">
        <span className="settings-row-label">{t('wallpaper.fit')}</span>
        <div className="seg" role="group" aria-label={t('wallpaper.fit')}>
          {(['cover', 'contain'] as const satisfies readonly WallpaperFit[]).map(fit => <button type="button" key={fit}
            className={'seg-btn' + (value.fit === fit ? ' on' : '')} aria-pressed={value.fit === fit} disabled={disabled}
            onClick={() => void wallpaper.setFit(fit)}>{t(`wallpaper.${fit}`)}</button>)}
        </div>
      </div>}
    </section>
  </div>
}
