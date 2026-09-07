import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { DEFAULT_BACKGROUND, DEFAULT_WALLPAPER, WALLPAPERS, validateWallpaperImage, type WallpaperFit, type WallpaperState } from './model'
import { loadWallpaper, saveWallpaper } from './storage'

type WallpaperError = 'load' | 'save' | 'type' | 'size' | 'decode'
interface WallpaperContextValue {
  value: WallpaperState
  style: CSSProperties
  ready: boolean
  busy: boolean
  error: WallpaperError | null
  selectPreset(id: string): Promise<void>
  upload(file: File): Promise<void>
  useImage(): Promise<void>
  removeImage(): Promise<void>
  setFit(fit: WallpaperFit): Promise<void>
}
const Context = createContext<WallpaperContextValue | null>(null)

export function WallpaperProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [value, setValue] = useState<WallpaperState>(DEFAULT_WALLPAPER)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<WallpaperError | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const saving = useRef(false)

  useEffect(() => {
    let active = true
    void loadWallpaper()
      .then(saved => { if (active) setValue(saved) })
      .catch(() => { if (active) setError('load') })
      .finally(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!value.image) { setImageUrl(null); return }
    const url = URL.createObjectURL(value.image)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [value.image])

  const style = useMemo<CSSProperties>(() => {
    if (value.mode === 'image' && imageUrl) {
      return { backgroundColor: 'var(--bg)', backgroundImage: `url("${imageUrl}")`, backgroundSize: value.fit, backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }
    }
    return { background: WALLPAPERS.find(preset => preset.id === value.presetId)?.background ?? DEFAULT_BACKGROUND }
  }, [value.mode, value.presetId, value.fit, imageUrl])

  // Only publish a selection after the storage transaction commits. A failed
  // write must not pretend the new wallpaper will survive a restart.
  async function commit(next: WallpaperState): Promise<void> {
    await saveWallpaper(next)
    setValue(next)
  }
  async function change(next: WallpaperState): Promise<void> {
    if (!ready || saving.current) return
    saving.current = true
    setBusy(true)
    setError(null)
    try { await commit(next) }
    catch { setError('save') }
    finally { saving.current = false; setBusy(false) }
  }
  async function upload(file: File): Promise<void> {
    if (!ready || saving.current) return
    const invalid = validateWallpaperImage(file)
    if (invalid) { setError(invalid); return }
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      // MIME and filename alone do not establish that a file is decodable.
      let bitmap: ImageBitmap
      try { bitmap = await createImageBitmap(file) }
      catch { setError('decode'); return }
      bitmap.close()
      await commit({ ...value, mode: 'image', image: file, imageName: file.name })
    } catch { setError('save') }
    finally { saving.current = false; setBusy(false) }
  }

  return <Context.Provider value={{
    value, style, ready, busy, error, upload,
    selectPreset: async id => {
      if (WALLPAPERS.some(preset => preset.id === id)) await change({ ...value, mode: 'preset', presetId: id })
    },
    useImage: async () => { if (value.image) await change({ ...value, mode: 'image' }) },
    removeImage: async () => { await change({ mode: 'preset', presetId: value.presetId, fit: value.fit }) },
    setFit: async fit => { await change({ ...value, fit }) }
  }}>{children}</Context.Provider>
}

export function useWallpaper(): WallpaperContextValue {
  const context = useContext(Context)
  if (!context) throw new Error('WallpaperProvider is missing')
  return context
}
