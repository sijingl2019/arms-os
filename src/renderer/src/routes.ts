import type { AppIconName } from './desktop/AppIcon'
import type { IconName } from './desktop/icons'

/**
 * The six panels the Dock opens. `null` is the desktop itself - there is no
 * router and no URL, because a single-window desktop app has neither history
 * nor deep links to serve.
 */
export const PANEL_IDS = ['Skills', 'Routines', 'Runs', 'Memory', 'Gateway', 'Settings'] as const

export type PanelId = (typeof PANEL_IDS)[number]

/** `null` means the desktop is showing. */
export type Route = PanelId | null

export interface PanelMeta {
  id: PanelId
  icon: IconName
  /** The colourful tile the Dock shows; `icon` stays for monochrome contexts. */
  tile: AppIconName
  /** Shown in the Dock tooltip and as the overlay's heading. */
  label: string
}

export const PANELS: readonly PanelMeta[] = [
  { id: 'Skills', icon: 'skills', tile: 'skills', label: 'Skills' },
  { id: 'Routines', icon: 'routines', tile: 'routines', label: 'Routines' },
  { id: 'Runs', icon: 'runs', tile: 'runs', label: 'Runs' },
  { id: 'Memory', icon: 'memory', tile: 'memory', label: 'Memory' },
  { id: 'Gateway', icon: 'gateway', tile: 'gateway', label: 'Gateway' },
  { id: 'Settings', icon: 'settings', tile: 'settings', label: 'Settings' }
]
