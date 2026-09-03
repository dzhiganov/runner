import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExternalProcess, ProjectConfig, ProjectRuntime } from '@shared/types.js'
import { score } from '@shared/fuzzy.js'

export interface Command {
  id: string
  /** What the row reads, e.g. "Restart api". */
  title: string
  /** Right-aligned context: the project, or the kind of thing this is. */
  hint?: string
  run: () => void
}

interface Props {
  commands: Command[]
  onClose: () => void
}

const RECENT_KEY = 'runner.recentCommands'
const MAX_RECENT = 12

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function remember(id: string): void {
  try {
    const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, MAX_RECENT)
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // A full or disabled store is not worth interrupting the app over.
  }
}

export default function CommandPalette({ commands, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const recent = useRef(loadRecent())
  const listRef = useRef<HTMLDivElement | null>(null)

  const matches = useMemo(() => {
    const scored = commands
      .map((command) => ({
        command,
        // The hint is searched too, so "api" finds every command for that
        // project without having to remember which verb comes first.
        score: score(query, `${command.title} ${command.hint ?? ''}`)
      }))
      .filter((entry): entry is { command: Command; score: number } => entry.score !== null)

    return scored
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score
        // With nothing typed every score is 0, so recency is what orders the
        // list — which is the whole point of opening it and pressing Enter.
        const ai = recent.current.indexOf(a.command.id)
        const bi = recent.current.indexOf(b.command.id)
        if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
        return a.command.title.localeCompare(b.command.title)
      })
      .slice(0, 40)
      .map((entry) => entry.command)
  }, [commands, query])

  useEffect(() => setCursor(0), [query])

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('.palette-row.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const choose = (command: Command | undefined): void => {
    if (!command) return
    remember(command.id)
    onClose()
    command.run()
  }

  const onKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((c) => Math.min(c + 1, matches.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(matches[cursor])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div className="overlay palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="Run a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list" ref={listRef}>
          {matches.length === 0 ? (
            <p className="palette-empty">Nothing matches.</p>
          ) : (
            matches.map((command, i) => (
              <button
                key={command.id}
                className={`palette-row ${i === cursor ? 'on' : ''}`}
                onMouseMove={() => setCursor(i)}
                onClick={() => choose(command)}
              >
                <span className="truncate">{command.title}</span>
                {command.hint && <span className="palette-hint truncate">{command.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** Every command the palette can offer, for the current state of the app. */
export function buildCommands(
  projects: ProjectConfig[],
  runtimeFor: (id: string) => ProjectRuntime,
  isLive: (id: string) => boolean,
  externals: Record<string, ExternalProcess>,
  actions: {
    select: (id: string) => void
    openLogs: () => void
    openDiscovery: () => void
    openEditor: (id?: string) => void
    openConflict: (id: string) => void
  }
): Command[] {
  const commands: Command[] = [
    { id: 'logs', title: 'Open all logs', hint: 'View', run: actions.openLogs },
    { id: 'discover', title: 'Find projects on disk', hint: 'Projects', run: actions.openDiscovery },
    { id: 'edit', title: 'Edit configuration', hint: 'Projects', run: () => actions.openEditor() },
    {
      id: 'start-all',
      title: 'Start all projects',
      hint: 'Global',
      run: () => projects.forEach((p) => void window.runner.start(p.id))
    },
    {
      id: 'stop-all',
      title: 'Stop all projects',
      hint: 'Global',
      run: () => projects.forEach((p) => void window.runner.stop(p.id))
    }
  ]

  for (const project of projects) {
    const live = isLive(project.id)
    const runtime = runtimeFor(project.id)
    const at = project.name

    commands.push({ id: `open:${project.id}`, title: `Go to ${at}`, hint: 'Project', run: () => actions.select(project.id) })

    if (live) {
      commands.push(
        { id: `stop:${project.id}`, title: `Stop ${at}`, hint: at, run: () => void window.runner.stop(project.id) },
        { id: `restart:${project.id}`, title: `Restart ${at}`, hint: at, run: () => void window.runner.restart(project.id) }
      )
    } else if (runtime.portsBusy) {
      // Starting is not on offer while the ports are taken, so the useful
      // command is the one that shows what is holding them.
      commands.push({
        id: `conflict:${project.id}`,
        title: `Free the ports for ${at}`,
        hint: at,
        run: () => actions.openConflict(project.id)
      })
    } else {
      commands.push({ id: `start:${project.id}`, title: `Start ${at}`, hint: at, run: () => void window.runner.start(project.id) })
      if (project.dependsOn?.length) {
        commands.push({
          id: `start-alone:${project.id}`,
          title: `Start ${at} alone`,
          hint: at,
          run: () => void window.runner.startOnly(project.id)
        })
      }
    }

    const ports = live
      ? (runtime.detectedPorts.length ? runtime.detectedPorts : runtime.port === null ? [] : [runtime.port])
      : (externals[project.id]?.ports ?? [])
    for (const port of ports.slice(0, 3)) {
      const url = `${project.protocol ?? 'http'}://localhost:${port}`
      commands.push({
        id: `open-url:${project.id}:${port}`,
        title: `Open ${at} in the browser`,
        hint: `:${port}`,
        run: () => void window.runner.openExternal(url)
      })
    }

    commands.push(
      { id: `folder:${project.id}`, title: `Open the ${at} folder`, hint: at, run: () => void window.runner.openPath(project.path) },
      { id: `config:${project.id}`, title: `Configure ${at}`, hint: at, run: () => actions.openEditor(project.id) }
    )
  }

  return commands
}
