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
  /** Shown in the Dock tooltip and as the overlay's heading. */
  label: string
}

export const PANELS: readonly PanelMeta[] = [
  { id: 'Skills', icon: 'skills', label: 'Skills' },
  { id: 'Routines', icon: 'routines', label: 'Routines' },
  { id: 'Runs', icon: 'runs', label: 'Runs' },
  { id: 'Memory', icon: 'memory', label: 'Memory' },
  { id: 'Gateway', icon: 'gateway', label: 'Gateway' },
  { id: 'Settings', icon: 'settings', label: '设置' }
]
