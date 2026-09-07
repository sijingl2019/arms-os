import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ShellPreferences } from './i18n/useI18n'
import { WallpaperProvider } from './wallpaper/WallpaperProvider'
import './theme.css'
import './desktop.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <React.StrictMode>
    <ShellPreferences>
      <WallpaperProvider>
        <App />
      </WallpaperProvider>
    </ShellPreferences>
  </React.StrictMode>
)
