import { describe, expect, it } from 'vitest'
import { DEFAULT_WALLPAPER, normalizeWallpaper, validateWallpaperImage } from '@renderer/wallpaper/model'

describe('wallpaper preferences', () => {
  it('recovers from missing, malformed and unknown stored preferences', () => {
    for (const value of [undefined, null, 'broken', {}, { mode: 'preset', presetId: 'missing' }]) {
      expect(normalizeWallpaper(value)).toEqual(DEFAULT_WALLPAPER)
    }
  })
  it('restores a selected built-in background', () => {
    expect(normalizeWallpaper({ mode: 'preset', presetId: 'graphite', fit: 'contain' }))
      .toMatchObject({ mode: 'preset', presetId: 'graphite', fit: 'contain' })
  })
  it('retains a saved image when the user switches to a preset', () => {
    const image = new Blob(['image'], { type: 'image/png' })
    expect(normalizeWallpaper({ mode: 'preset', presetId: 'graphite', image, imageName: 'photo.png' }).image).toBe(image)
  })
  it('falls back to the default when an image record has no usable image', () => {
    expect(normalizeWallpaper({ mode: 'image', presetId: 'graphite', image: 'file:///missing' }).mode).toBe('preset')
    expect(normalizeWallpaper({ mode: 'image' }).presetId).toBe('default')
  })
  it('normalizes unsupported image fit values', () => {
    expect(normalizeWallpaper({ mode: 'preset', presetId: 'graphite', fit: 'unsafe' }).fit).toBe('cover')
  })
  it('rejects unsupported files, empty images and images above 12 MiB', () => {
    expect(validateWallpaperImage({ type: 'image/svg+xml', size: 100 })).toBe('type')
    expect(validateWallpaperImage({ type: 'image/png', size: 0 })).toBe('size')
    expect(validateWallpaperImage({ type: 'image/jpeg', size: 12 * 1024 * 1024 + 1 })).toBe('size')
    expect(validateWallpaperImage({ type: 'image/webp', size: 12 * 1024 * 1024 })).toBeNull()
  })
})
