import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LogLevel, LogLine, ProjectConfig } from '@shared/types.js'

interface Props {
  projects: ProjectConfig[]
}

/** How many lines the view holds before dropping the oldest from the top. */
const MAX_RENDERED = 5_000

/** Distance from the bottom still counted as "at the bottom", in pixels. */
const STICK_SLACK = 40

const LEVEL_FILTERS: { label: string; levels: LogLevel[] }[] = [
  { label: 'All', levels: [] },
  { label: 'Errors', levels: ['error'] },
  { label: 'Warnings', levels: ['warn'] }
]

function clockOf(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

export default function LogView({ projects }: Props): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([])
  const [search, setSearch] = useState('')
  const [levelIndex, setLevelIndex] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState(false)

  const scroller = useRef<HTMLDivElement | null>(null)
  /** Whether the view was pinned to the bottom before the last render. */
  const stuck = useRef(true)

  const levels = LEVEL_FILTERS[levelIndex].levels
  const names = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  )

  const query = useCallback(
    () => ({
      search,
      levels,
      projectIds: [...selected],
      limit: MAX_RENDERED
    }),
    [search, levels, selected]
  )

  // A filter change re-asks the main process rather than filtering in place:
  // the store holds far more than the view does, so narrowing here would only
  // ever search what happened to already be on screen.
  useEffect(() => {
    let cancelled = false
    window.runner.queryLogs(query()).then((result) => {
      if (!cancelled) setLines(result)
    })
    return () => {
      cancelled = true
    }
  }, [query])

  // Live lines are matched against the same filters, so a paused or filtered
  // view does not quietly start showing everything again.
  useEffect(() => {
    if (paused) return
    const needle = search.trim().toLowerCase()
    return window.runner.onLogLine((line) => {
      if (levels.length && !levels.includes(line.level)) return
      if (selected.size && !selected.has(line.projectId)) return
      if (needle && !line.text.toLowerCase().includes(needle)) return
      setLines((prev) => {
        const next = [...prev, line]
        return next.length > MAX_RENDERED ? next.slice(-MAX_RENDERED) : next
      })
    })
  }, [paused, search, levels, selected])

  // Auto-scroll only while the user has not scrolled away. Yanking someone
  // back to the bottom while they are reading history is worse than no
  // auto-scroll at all.
  useEffect(() => {
    const el = scroller.current
    if (!el || !stuck.current) return
    el.scrollTop = el.scrollHeight
  }, [lines])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK
  }

  const toggleProject = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const asText = (): string =>
    lines.map((l) => `${clockOf(l.at)} ${names.get(l.projectId) ?? l.projectId} ${l.text}`).join('\n')

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(asText())
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const save = async (): Promise<void> => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    await window.runner.saveText(`runner-logs-${stamp}.txt`, asText())
  }

  const clear = async (): Promise<void> => {
    await window.runner.clearLogs()
    setLines([])
  }

  return (
    <div className="logs">
      <header className="logs-bar">
        <input
          className="logs-search"
          type="search"
          placeholder="Search all output…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="tabs">
          {LEVEL_FILTERS.map((filter, i) => (
            <button
              key={filter.label}
              className={`tab ${i === levelIndex ? 'on' : ''}`}
              onClick={() => setLevelIndex(i)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <span className="spacer" />

        <button
          className={`btn small ${paused ? 'primary' : ''}`}
          title={paused ? 'Resume following new output' : 'Stop following new output'}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? 'Paused' : 'Following'}
        </button>
        <button className="btn small" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn small" onClick={() => void save()}>
          Export
        </button>
        <button className="btn small" onClick={() => void clear()}>
          Clear
        </button>
      </header>

      {projects.length > 1 && (
        <div className="logs-projects">
          {projects.map((project) => (
            <button
              key={project.id}
              className={`chip-toggle ${selected.has(project.id) ? 'on' : ''}`}
              onClick={() => toggleProject(project.id)}
            >
              {project.name}
            </button>
          ))}
          {selected.size > 0 && (
            <button className="btn link" onClick={() => setSelected(new Set())}>
              Show all
            </button>
          )}
        </div>
      )}

      <div className="logs-body" ref={scroller} onScroll={onScroll}>
        {lines.length === 0 ? (
          <p className="logs-empty">
            {search || levels.length || selected.size
              ? 'Nothing matches those filters.'
              : 'Nothing has been logged yet. Start a project and its output appears here.'}
          </p>
        ) : (
          lines.map((line) => (
            <div className={`logs-line ${line.level}`} key={line.seq}>
              <span className="logs-time">{clockOf(line.at)}</span>
              <span className="logs-src truncate">{names.get(line.projectId) ?? '—'}</span>
              <span className="logs-text">{line.text}</span>
            </div>
          ))
        )}
      </div>

      <footer className="statusbar">
        <span>
          {lines.length} {lines.length === 1 ? 'line' : 'lines'}
          {lines.length >= MAX_RENDERED ? ' (newest)' : ''}
        </span>
        {selected.size > 0 && <span>{selected.size} of {projects.length} projects</span>}
        {paused && <span>paused — new output is still being collected</span>}
      </footer>
    </div>
  )
}
