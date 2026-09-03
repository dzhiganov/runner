/**
 * The app's icon set, drawn inline.
 *
 * Lucide's geometry and its 24×24 / stroke-2 grid, kept as source rather than
 * pulled in as a package: a dozen glyphs do not justify a runtime dependency in
 * an app that otherwise ships none, and inlining keeps them themable with
 * `currentColor` and free of a network fetch at first paint.
 */

interface IconProps {
  size?: number
  className?: string
  /** Rendered as a tooltip and as the accessible name. */
  title?: string
}

function Svg({
  size = 14,
  className,
  title,
  children
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  )
}

/** Collapsed / expanded affordance on a tree row. */
export function ChevronIcon({ open, ...props }: IconProps & { open: boolean }): React.JSX.Element {
  return (
    <Svg {...props}>
      {open ? <polyline points="6 9 12 15 18 9" /> : <polyline points="9 6 15 12 9 18" />}
    </Svg>
  )
}

/**
 * The working indicator: an arc that spins. Kept as a partial circle rather
 * than a dashed ring so it reads as motion even at sidebar size.
 */
export function SpinnerIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props} className={props.className ? `spin ${props.className}` : 'spin'}>
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </Svg>
  )
}

/** Something went wrong: a crash, a failed start, a dependency that never came up. */
export function AlertIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Svg>
  )
}

export function PlayIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function StopIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function ExternalLinkIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </Svg>
  )
}

/** Marks a project other projects are built on top of. */
export function LayersIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </Svg>
  )
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />
    </Svg>
  )
}

/** An app. The only kind of thing Runner runs, so the only kind of row icon. */
export function BoxIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <polyline points="3.3 7 12 12 20.7 7" />
      <line x1="12" y1="22" x2="12" y2="12" />
    </Svg>
  )
}

/** Opens the folder scan that looks for projects on disk. */
export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  )
}

/** The merged log view: several streams stacked into one. */
export function ListIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </Svg>
  )
}

/** Git branch, for the worktree a project is checked out on. */
export function BranchIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Svg>
  )
}

/** The environment view: repositories and the services inside them. */
export function LayoutIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </Svg>
  )
}
