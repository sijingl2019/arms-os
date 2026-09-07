/**
 * Every icon in the shell, as inline SVG path data.
 *
 * Inline rather than an icon package: the renderer's CSP is `script-src 'self'`
 * and a dozen outlines are not worth a dependency. All of them are drawn on the
 * same 24x24 grid as strokes, so they stay visually consistent at Dock size.
 */

export type IconName =
  | 'home'
  | 'skills'
  | 'routines'
  | 'runs'
  | 'memory'
  | 'gateway'
  | 'settings'
  | 'apps'
  | 'calendar'
  | 'git'
  | 'email'
  | 'open'
  | 'search'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  | 'sun'
  | 'moon'
  | 'language'
  | 'trash'
  | 'send'
  | 'stop'
  | 'paperclip'

const PATHS: Record<IconName, readonly string[]> = {
  home: ['M3 11l9-8 9 8', 'M5 10v10h14V10'],
  skills: ['M12 3l2.2 5.3L20 10l-5.8 1.7L12 17l-2.2-5.3L4 10l5.8-1.7z', 'M6 18l1 3 1-3 3-1-3-1'],
  routines: ['M20.5 12a8.5 8.5 0 1 1-2.6-6.1', 'M21 3v5h-5', 'M12 8v4.3l2.8 1.7'],
  runs: ['M4 5h16v14H4z', 'M8 10l2.5 2L8 14', 'M13 14h4'],
  memory: [
    'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z',
    'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
    'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'
  ],
  gateway: ['M12 3l7 3v6c0 4.4-3 8.2-7 9-4-.8-7-4.6-7-9V6z', 'M9 12l2 2 4-4'],
  settings: ['M4 7h11', 'M19 7h1', 'M4 17h11', 'M19 17h1', 'M17 7a2 2 0 1 0-4 0 2 2 0 0 0 4 0z', 'M11 17a2 2 0 1 0-4 0 2 2 0 0 0 4 0z'],
  apps: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  git: [
    'M6 6v12',
    'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M6 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M18 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M18 10a9 9 0 0 1-9 8'
  ],
  email: ['M3 6h18v12H3z', 'M3 7.5l9 6 9-6'],
  open: ['M14 4h6v6', 'M20 4l-8 8', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
  minimize: ['M5 12h14'],
  maximize: ['M5 5h14v14H5z'],
  restore: ['M8 8h11v11H8z', 'M5 16V5h11'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  sun: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    'M12 2v2',
    'M12 20v2',
    'M2 12h2',
    'M20 12h2',
    'M4.9 4.9l1.4 1.4',
    'M17.7 17.7l1.4 1.4',
    'M19.1 4.9l-1.4 1.4',
    'M6.3 17.7l-1.4 1.4'
  ],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'],
  trash: ['M4 7h16', 'M9.5 7V4.8h5V7', 'M6.5 7l1 12.5h9L17.5 7', 'M10.5 10.5v6', 'M13.5 10.5v6'],
  send: ['M4.5 12L20 4.5 12.5 20l-2-6z', 'M10.5 14l9.5-9.5'],
  stop: ['M7 7h10v10H7z'],
  paperclip: ['M20 11.5l-8.2 8.2a4.6 4.6 0 0 1-6.5-6.5l8.6-8.6a3.1 3.1 0 0 1 4.4 4.4l-8.6 8.6a1.6 1.6 0 0 1-2.2-2.2l7.9-7.9'],
  language: [
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
    'M3.6 9h16.8',
    'M3.6 15h16.8',
    'M12 3c2.4 2.4 3.6 5.4 3.6 9s-1.2 6.6-3.6 9c-2.4-2.4-3.6-5.4-3.6-9s1.2-6.6 3.6-9z'
  ]
}

export interface IconProps {
  name: IconName
  size?: number
}

export function Icon({ name, size = 20 }: IconProps): React.JSX.Element {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
