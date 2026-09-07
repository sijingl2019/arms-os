import { normalizeWallpaper, type WallpaperState } from './model'

/** One atomic record keeps the chosen material and uploaded image in sync.
 * IndexedDB stores the image locally, without localStorage's small string quota. */
async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('arms-appearance', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('wallpaper')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Wallpaper storage is blocked'))
  })
}

export async function loadWallpaper(): Promise<WallpaperState> {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('wallpaper', 'readonly')
      const request = tx.objectStore('wallpaper').get('current')
      tx.oncomplete = () => resolve(normalizeWallpaper(request.result))
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => reject(tx.error)
    })
  } finally { db.close() }
}

export async function saveWallpaper(value: WallpaperState): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('wallpaper', 'readwrite')
      tx.objectStore('wallpaper').put(value, 'current')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => reject(tx.error)
    })
  } finally { db.close() }
}
