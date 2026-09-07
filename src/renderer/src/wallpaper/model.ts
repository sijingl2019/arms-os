/** Curated, low-saturation materials; the default follows the app theme. */
export const DEFAULT_BACKGROUND = `radial-gradient(ellipse at 16% 12%, var(--wallpaper-blue), transparent 62%), radial-gradient(ellipse at 88% 20%, var(--wallpaper-mint), transparent 58%), radial-gradient(ellipse at 75% 92%, var(--wallpaper-lilac), transparent 62%), radial-gradient(ellipse at 10% 86%, var(--wallpaper-peach), transparent 52%), var(--bg)`

export const WALLPAPERS = [
  { id: 'default', kind: 'adaptive', name: { zh: '流光', en: 'Liquid Light' }, background: DEFAULT_BACKGROUND },
  { id: 'graphite', kind: 'solid', name: { zh: '曜石黑', en: 'Graphite' }, background: '#252b35' },
  { id: 'ink', kind: 'solid', name: { zh: '深海蓝', en: 'Midnight' }, background: '#273c50' },
  { id: 'stone', kind: 'solid', name: { zh: '暖砂岩', en: 'Sandstone' }, background: '#d6ccbf' },
  { id: 'sage', kind: 'solid', name: { zh: '鼠尾草', en: 'Sage' }, background: '#a9b7ae' },
  { id: 'mist', kind: 'solid', name: { zh: '雾凇蓝', en: 'Blue Mist' }, background: '#b5c6d7' },
  { id: 'pearl', kind: 'solid', name: { zh: '月光白', en: 'Pearl' }, background: '#e9e6e1' },
  { id: 'coast', kind: 'gradient', name: { zh: '海岸晨雾', en: 'Coastal Haze' }, background: 'linear-gradient(135deg, #9cb6cb 0%, #c4d4d8 48%, #eee2d2 100%)' },
  { id: 'dusk', kind: 'gradient', name: { zh: '暮色山岚', en: 'Dusk' }, background: 'linear-gradient(145deg, #747b97 0%, #a6a2b7 48%, #dcc7bd 100%)' },
  { id: 'glacier', kind: 'gradient', name: { zh: '冰川湖光', en: 'Glacier' }, background: 'linear-gradient(135deg, #779aa7 0%, #b5d2d0 52%, #e2e9df 100%)' },
  { id: 'silk', kind: 'gradient', name: { zh: '香槟丝缎', en: 'Champagne Silk' }, background: 'linear-gradient(135deg, #bcad9a 0%, #dfd4c5 50%, #f3ece4 100%)' },
  { id: 'nocturne', kind: 'gradient', name: { zh: '极夜微光', en: 'Nocturne' }, background: 'radial-gradient(ellipse at 80% 15%, #4c6176, transparent 65%), linear-gradient(150deg, #202a3b, #3a4656 65%, #696476)' },
  { id: 'garden', kind: 'gradient', name: { zh: '苔原静境', en: 'Quiet Garden' }, background: 'linear-gradient(140deg, #758b81 0%, #a5b3a2 48%, #d9d4bd 100%)' }
] as const

export type WallpaperFit = 'cover' | 'contain'
export interface WallpaperState {
  mode: 'preset' | 'image'
  presetId: string
  fit: WallpaperFit
  image?: Blob
  imageName?: string
}
export const DEFAULT_WALLPAPER: WallpaperState = { mode: 'preset', presetId: 'default', fit: 'cover' }
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export function validateWallpaperImage(file: { type: string; size: number }): 'type' | 'size' | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'type'
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_IMAGE_BYTES) return 'size'
  return null
}

/** Never turn persisted strings into arbitrary URLs or CSS. */
export function normalizeWallpaper(value: unknown): WallpaperState {
  if (!value || typeof value !== 'object') return { ...DEFAULT_WALLPAPER }
  const raw = value as Partial<WallpaperState>
  const presetId = WALLPAPERS.some(preset => preset.id === raw.presetId) ? raw.presetId! : 'default'
  const image = raw.image instanceof Blob && !validateWallpaperImage(raw.image) ? raw.image : undefined
  return {
    mode: raw.mode === 'image' && image ? 'image' : 'preset',
    presetId,
    fit: raw.fit === 'contain' ? 'contain' : 'cover',
    ...(image ? { image, imageName: typeof raw.imageName === 'string' ? raw.imageName : 'Wallpaper' } : {})
  }
}
