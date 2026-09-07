import { useId } from 'react'

/**
 * Dock icons, drawn as macOS-style app tiles: a rounded squircle carrying a
 * gradient, with a white glyph on top.
 *
 * Inline SVG rather than image assets - the renderer's CSP is `script-src
 * 'self'`, there is no asset pipeline for the Dock, and a gradient plus a path
 * is a few hundred bytes against a set of PNGs at three densities.
 *
 * The stroke icons in `icons.tsx` stay for widget headers and buttons; these
 * are only for the Dock, where colour is what makes a row of icons scannable.
 */

export type AppIconName =
  | 'desktop'
  | 'chat'
  | 'skills'
  | 'routines'
  | 'runs'
  | 'memory'
  | 'gateway'
  | 'settings'

interface Tile {
  /** Top and bottom of the tile's gradient. */
  from: string
  to: string
  /** Glyph paths, drawn white on the tile, on a 24x24 grid. */
  glyph: readonly string[]
  /** Filled glyphs (a chat bubble) rather than stroked ones. */
  filled?: boolean
}

const TILES: Record<AppIconName, Tile> = {
  desktop: {
    from: '#5ac8fa',
    to: '#0a84ff',
    glyph: ['M4 10.5 12 4l8 6.5', 'M6.5 9.5V19h11V9.5', 'M10 19v-5h4v5']
  },
  chat: {
    from: '#6ee787',
    to: '#26a641',
    filled: true,
    glyph: [
      'M12 4.5c-4.7 0-8.5 3-8.5 6.8 0 2.2 1.3 4.1 3.3 5.4-.2 1-.8 2.2-1.7 3.1 1.7-.2 3.3-.9 4.5-1.8.8.2 1.6.3 2.4.3 4.7 0 8.5-3 8.5-6.9S16.7 4.5 12 4.5z'
    ]
  },
  skills: {
    from: '#c77dff',
    to: '#7b2ff7',
    filled: true,
    glyph: [
      'M12 3.2l2.3 5.5 5.5 2.3-5.5 2.3L12 18.8l-2.3-5.5L4.2 11l5.5-2.3z',
      'M18.4 15.6l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z'
    ]
  },
  routines: {
    from: '#ffb340',
    to: '#f2670a',
    glyph: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20.5 3.5v4.2h-4.2', 'M12 7.6V12l3 1.9']
  },
  runs: {
    from: '#8e9aaf',
    to: '#4a5568',
    glyph: ['M4 5.5h16v13H4z', 'M8 10l2.6 2L8 14', 'M13 14.2h4']
  },
  memory: {
    from: '#5ee7df',
    to: '#0f9b8e',
    glyph: [
      'M12 3.6c4.2 0 7.6 1.2 7.6 2.8S16.2 9.2 12 9.2 4.4 8 4.4 6.4 7.8 3.6 12 3.6z',
      'M4.4 6.4v11.2c0 1.6 3.4 2.8 7.6 2.8s7.6-1.2 7.6-2.8V6.4',
      'M4.4 12c0 1.6 3.4 2.8 7.6 2.8s7.6-1.2 7.6-2.8'
    ]
  },
  gateway: {
    from: '#ff8a7a',
    to: '#e0353b',
    glyph: ['M12 3.4l7 3v5.8c0 4.3-2.9 8-7 8.8-4.1-.8-7-4.5-7-8.8V6.4z', 'M9 12l2.2 2.2L15.4 10']
  },
  settings: {
    from: '#c9d0d9',
    to: '#78838f',
    glyph: [
      'M4 7.4h10',
      'M18.6 7.4h1.4',
      'M4 16.6h10',
      'M18.6 16.6h1.4',
      'M16.4 7.4a2.2 2.2 0 1 0-4.4 0 2.2 2.2 0 0 0 4.4 0z',
      'M12 16.6a2.2 2.2 0 1 0-4.4 0 2.2 2.2 0 0 0 4.4 0z'
    ]
  }
}

export interface AppIconProps {
  name: AppIconName
  size?: number
}

export function AppIcon({ name, size = 44 }: AppIconProps): React.JSX.Element {
  const tile = TILES[name]
  // Scoped per icon: two of the same app in one document would otherwise share
  // (and fight over) a single gradient id.
  const gradientId = useId()
  const glossId = useId()

  return (
    <svg
      className="app-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tile.from} />
          <stop offset="100%" stopColor={tile.to} />
        </linearGradient>
        <linearGradient id={glossId} x1="0" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="48%" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0.16" />
        </linearGradient>
      </defs>

      {/* The tile. 5.6 of 24 is close to the macOS squircle's corner radius. */}
      <rect x="0.5" y="0.5" width="23" height="23" rx="5.6" fill={`url(#${gradientId})`} />
      <rect x="0.5" y="0.5" width="23" height="23" rx="5.6" fill={`url(#${glossId})`} />
      {/* A hairline highlight along the top edge, so tiles read as raised. */}
      <rect
        x="0.5"
        y="0.5"
        width="23"
        height="23"
        rx="5.6"
        fill="none"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth="0.8"
      />

      <g
        fill={tile.filled ? '#fff' : 'none'}
        stroke={tile.filled ? 'none' : '#fff'}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {tile.glyph.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  )
}
