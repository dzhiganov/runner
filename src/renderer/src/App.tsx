import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConfig, ProjectRuntime, RunnerConfig } from '@shared/types.js'
import { buildTree, type TreeNode } from '@shared/graph.js'
import TerminalHost from './components/TerminalHost.js'
import ConfigEditor from './components/ConfigEditor.js'
import DiscoverDialog from './components/DiscoverDialog.js'
import LogView from './components/LogView.js'
import PortConflictDialog from './components/PortConflictDialog.js'
import {
  AlertIcon,
  BoxIcon,
  ChevronIcon,
  ExternalLinkIcon,
  LayersIcon,
  PlayIcon,
  ListIcon,
  SearchIcon,
  SpinnerIcon,
  StopIcon
} from './components/Icons.js'

const EMPTY_RUNTIME = (id: string): ProjectRuntime => ({
  id,
  status: 'stopped',
  port: null,
  detectedPorts: [],
  portsBusy: false,
  pid: null,
  exitCode: null,
  message: null,
  startedAt: null,
  waitingFor: null,
  restartAttempts: 0
})

const STATUS_LABEL: Record<ProjectRuntime['status'], string> = {
  stopped: 'Stopped',
  waiting: 'Waiting',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  exited: 'Crashed',
  error: 'Error'
}

/** Statuses that mean "Runner is working on it" and should show the spinner. */
const BUSY: ProjectRuntime['status'][] = ['waiting', 'starting', 'stopping']
const BROKEN: ProjectRuntime['status'][] = ['exited', 'error']

const EXPANDED_KEY = 'runner.collapsedNodes'

/** Ports worth offering as links: what the app announced, else what we assigned. */
function portsOf(runtime: ProjectRuntime): number[] {
  if (runtime.detectedPorts.length) return runtime.detectedPorts
  return runtime.port === null ? [] : [runtime.port]
}

/** Compact port label for the sidebar, where there is no room for a full list. */
function portLabel(ports: number[]): string {
  if (!ports.length) return ''
  return ports.length === 1 ? `:${ports[0]}` : `:${ports[0]} +${ports.length - 1}`
}

function urlFor(project: ProjectConfig, port: number): string {
  return `${project.protocol ?? 'http'}://localhost:${port}`
}

function elapsed(since: number | null, now: number): string {
  if (!since) return ''
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export default function App(): React.JSX.Element {
  const [config, setConfig] = useState<RunnerConfig>({ projects: [] })
  const [runtimes, setRuntimes] = useState<Record<string, ProjectRuntime>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ open: boolean; id?: string | null }>({ open: false })
  const [discovering, setDiscovering] = useState(false)
  /** The merged log view replaces the project pane while it is open. */
  const [showLogs, setShowLogs] = useState(false)
  /** Project whose port conflict is being resolved, if any. */
  const [conflictFor, setConflictFor] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  /** Tree nodes the user folded away, by node key. Collapsed is the exception. */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const stored = window.localStorage.getItem(EXPANDED_KEY)
      return new Set<string>(stored ? (JSON.parse(stored) as string[]) : [])
    } catch {
      return new Set<string>()
    }
  })
  /** Kept so a rejected reorder can put the old order back. */
  const configBeforeDrag = useRef<RunnerConfig | null>(null)

  useEffect(() => {
    window.runner.getConfig().then((loaded) => {
      setConfig(loaded)
      setActiveId((current) => current ?? loaded.projects[0]?.id ?? null)
    })
    window.runner.getRuntimes().then((list) => {
      setRuntimes(Object.fromEntries(list.map((r) => [r.id, r])))
    })
  }, [])

  useEffect(() => {
    const offRuntime = window.runner.onRuntime((runtime) => {
      setRuntimes((prev) => ({ ...prev, [runtime.id]: runtime }))
    })
    const offConfig = window.runner.onConfigChanged((next) => setConfig(next))
    return () => {
      offRuntime()
      offConfig()
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...collapsed]))
    } catch {
      // A full or disabled store is not worth interrupting the app over.
    }
  }, [collapsed])

  // Keep the selection valid when projects are removed in the editor.
  useEffect(() => {
    if (activeId && !config.projects.some((p) => p.id === activeId)) {
      setActiveId(config.projects[0]?.id ?? null)
    }
    if (!activeId && config.projects.length) setActiveId(config.projects[0].id)
  }, [config, activeId])

  const runtimeFor = useCallback(
    (id: string): ProjectRuntime => runtimes[id] ?? EMPTY_RUNTIME(id),
    [runtimes]
  )

  const active = useMemo(
    () => config.projects.find((p) => p.id === activeId) ?? null,
    [config, activeId]
  )
  const activeRuntime = active ? runtimeFor(active.id) : null
  const tree = useMemo(() => buildTree(config.projects), [config.projects])
  const nameOf = useCallback(
    (id: string): string => config.projects.find((p) => p.id === id)?.name ?? 'a dependency',
    [config.projects]
  )

  const isLive = (id: string): boolean =>
    ['running', 'starting', 'stopping', 'waiting'].includes(runtimeFor(id).status)

  const busyTitle = (project: ProjectConfig): string =>
    `All ports are in use: ${(project.port ?? []).join(', ')}`

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || !activeId) return
      if (event.key === 'r') {
        event.preventDefault()
        window.runner.restart(activeId)
      } else if (event.key === '.') {
        event.preventDefault()
        window.runner.stop(activeId)
      } else if (event.key === ',') {
        event.preventDefault()
        setEditing({ open: true, id: activeId })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId])

  /** Moves `fromId` to `toId`'s slot and persists the new order. */
  const reorder = async (fromId: string, toId: string): Promise<void> => {
    if (fromId === toId) return
    const previous = configBeforeDrag.current ?? config
    const list = [...config.projects]
    const from = list.findIndex((p) => p.id === fromId)
    const to = list.findIndex((p) => p.id === toId)
    if (from < 0 || to < 0) return

    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    setConfig({ projects: list })

    const result = await window.runner.saveConfig({ projects: list })
    if (!result.ok) setConfig(previous)
  }

  const toggle = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Meta line under a project's name: what it is doing, where, for how long. */
  const metaFor = (runtime: ProjectRuntime): string => {
    if (runtime.status === 'waiting') {
      return runtime.waitingFor ? `Waiting for ${nameOf(runtime.waitingFor)}` : 'Waiting'
    }
    return [
      STATUS_LABEL[runtime.status],
      // A crash loop is the one thing worth saying twice: the row would
      // otherwise just flicker between Crashed and Running on its own.
      runtime.restartAttempts > 0 ? `retry ${runtime.restartAttempts}` : '',
      portLabel(portsOf(runtime)),
      runtime.status === 'running' && runtime.startedAt ? elapsed(runtime.startedAt, now) : ''
    ]
      .filter(Boolean)
      .join(' · ')
  }

  const renderNode = (node: TreeNode, isRoot: boolean): React.JSX.Element => {
    const { project } = node
    const runtime = runtimeFor(project.id)
    const live = isLive(project.id)
    const ports = portsOf(runtime)
    const blocked = !live && runtime.portsBusy
    const open = !collapsed.has(node.key)
    const hasChildren = node.children.length > 0

    return (
      <div className="tree-node" key={node.key}>
        <div
          className={[
            'project',
            project.id === activeId && !showLogs ? 'on' : '',
            dragId === project.id ? 'dragging' : '',
            dropId === project.id && dragId !== project.id ? 'drop-target' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => {
            setActiveId(project.id)
            setShowLogs(false)
          }}
          // Reordering only makes sense between siblings at the root: a child's
          // position is dictated by the dependency that owns it.
          draggable={isRoot}
          onDragStart={(e) => {
            if (!isRoot) return
            configBeforeDrag.current = config
            setDragId(project.id)
            e.dataTransfer.effectAllowed = 'move'
            // Firefox/Chromium refuse to start a drag with no payload.
            e.dataTransfer.setData('text/plain', project.id)
          }}
          onDragOver={(e) => {
            if (!dragId || !isRoot) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropId(project.id)
          }}
          onDragLeave={() => setDropId((id) => (id === project.id ? null : id))}
          onDrop={(e) => {
            if (!isRoot) return
            e.preventDefault()
            const from = dragId ?? e.dataTransfer.getData('text/plain')
            setDragId(null)
            setDropId(null)
            if (from) void reorder(from, project.id)
          }}
          onDragEnd={() => {
            setDragId(null)
            setDropId(null)
          }}
        >
          {hasChildren ? (
            <button
              className="btn ghost icon twisty"
              title={open ? 'Collapse dependencies' : 'Expand dependencies'}
              onClick={(e) => {
                e.stopPropagation()
                toggle(node.key)
              }}
            >
              <ChevronIcon open={open} size={12} />
            </button>
          ) : (
            <span className="twisty-spacer" />
          )}

          <span className={`kind ${runtime.status}`}>
            <BoxIcon size={14} title={project.name} />
          </span>

          <div className="project-text">
            <div className="project-name-row">
              <span className="project-name truncate">{project.name}</span>
              {BUSY.includes(runtime.status) && (
                <SpinnerIcon size={11} className="status-mark busy" title={STATUS_LABEL[runtime.status]} />
              )}
              {BROKEN.includes(runtime.status) && (
                <AlertIcon
                  size={12}
                  className="status-mark broken"
                  title={runtime.message ?? STATUS_LABEL[runtime.status]}
                />
              )}
              {runtime.status === 'running' && <span className="dot running" />}
            </div>
            <div className="project-meta truncate">{metaFor(runtime)}</div>
          </div>

          {live && ports.length > 0 && (
            <button
              className="btn ghost icon open-link"
              title={`Open ${urlFor(project, ports[0])}`}
              onClick={(e) => {
                e.stopPropagation()
                window.runner.openExternal(urlFor(project, ports[0]))
              }}
            >
              <ExternalLinkIcon size={12} />
            </button>
          )}

          <button
            className="btn ghost icon run-toggle"
            title={
              live
                ? hasChildren
                  ? 'Stop this project and its dependencies'
                  : 'Stop'
                : blocked
                  ? busyTitle(project)
                  : hasChildren
                    ? 'Run, starting its dependencies first'
                    : 'Run'
            }
            disabled={blocked}
            onClick={(e) => {
              e.stopPropagation()
              if (live) window.runner.stop(project.id)
              else if (!blocked) window.runner.start(project.id)
            }}
          >
            {live ? <StopIcon size={10} /> : <PlayIcon size={10} />}
          </button>
        </div>

        {hasChildren && open && (
          <div className="tree-children">
            {node.children.map((child) => renderNode(child, false))}
          </div>
        )}
      </div>
    )
  }

  const dependencyNames = active
    ? (active.dependsOn ?? []).map((id) => ({ id, name: nameOf(id) }))
    : []

  return (
    <div className="app">
      <div className="titlebar" />

      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">Runner</span>
          <button
            className="btn ghost gear"
            title="Find projects on disk"
            onClick={() => setDiscovering(true)}
          >
            <SearchIcon size={13} />
          </button>
          <button
            className="btn ghost gear"
            title="Edit configuration (⌘,)"
            onClick={() => setEditing({ open: true, id: activeId })}
          >
            ⚙
          </button>
        </div>

        <div className="project-list">
          {config.projects.length > 0 && (
            <button
              className={`logs-entry ${showLogs ? 'on' : ''}`}
              onClick={() => setShowLogs(true)}
            >
              <ListIcon size={13} />
              All logs
            </button>
          )}

          {tree.map((node) => renderNode(node, true))}

          {config.projects.length === 0 && (
            <button className="empty-add" onClick={() => setDiscovering(true)}>
              + Add your first project
            </button>
          )}
        </div>
      </aside>

      <main className="main">
        {showLogs ? (
          <LogView projects={config.projects} />
        ) : active && activeRuntime ? (
          <>
            <header className="toolbar">
              <div className="toolbar-title">
                <span className={`kind ${activeRuntime.status}`}>
                  <BoxIcon size={15} />
                </span>
                <strong>{active.name}</strong>
                {BUSY.includes(activeRuntime.status) && <SpinnerIcon size={12} className="busy" />}
                {BROKEN.includes(activeRuntime.status) && (
                  <AlertIcon size={13} className="broken" />
                )}
                <span className="path truncate">{active.path}</span>
              </div>

              <div className="toolbar-actions">
                {isLive(active.id) &&
                  portsOf(activeRuntime)
                    .slice(0, 4)
                    .map((port) => (
                      <button
                        key={port}
                        className="btn ghost link"
                        title={`Open ${urlFor(active, port)}`}
                        onClick={() => window.runner.openExternal(urlFor(active, port))}
                      >
                        :{port} <ExternalLinkIcon size={11} />
                      </button>
                    ))}
                <button className="btn ghost" onClick={() => window.runner.openPath(active.path)}>
                  Folder
                </button>
                <button
                  className="btn"
                  title="Restart (⌘R)"
                  onClick={() => window.runner.restart(active.id)}
                >
                  Restart
                </button>
                {isLive(active.id) ? (
                  <>
                    {dependencyNames.length > 0 && (
                      <button
                        className="btn ghost"
                        title="Stop this project, leaving its dependencies running"
                        onClick={() => window.runner.stopOnly(active.id)}
                      >
                        Stop only
                      </button>
                    )}
                    <button
                      className="btn danger"
                      title="Stop (⌘.)"
                      onClick={() => window.runner.stop(active.id)}
                    >
                      Stop
                    </button>
                  </>
                ) : (
                  <>
                    {dependencyNames.length > 0 && (
                      <button
                        className="btn ghost"
                        title="Start this project alone, assuming its dependencies are already up"
                        onClick={() => window.runner.startOnly(active.id)}
                      >
                        Run alone
                      </button>
                    )}
                    <button
                      className={`btn ${activeRuntime.portsBusy ? 'danger' : 'primary'}`}
                      title={
                        activeRuntime.portsBusy
                          ? `${busyTitle(active)} — see what is holding them`
                          : dependencyNames.length
                            ? `Run, starting ${dependencyNames.map((d) => d.name).join(', ')} first`
                            : 'Run'
                      }
                      // A disabled button is a dead end: it says the ports are
                      // taken but not by what, leaving the terminal as the only
                      // way to find out. Busy turns Run into the way in.
                      onClick={() =>
                        activeRuntime.portsBusy
                          ? setConflictFor(active.id)
                          : window.runner.start(active.id)
                      }
                    >
                      {activeRuntime.portsBusy ? 'Port in use' : 'Run'}
                    </button>
                  </>
                )}
              </div>
            </header>

            {activeRuntime.message && (
              <div className={`banner ${activeRuntime.status}`}>{activeRuntime.message}</div>
            )}

            {dependencyNames.length > 0 && (
              <div className="deps-bar">
                <LayersIcon size={12} />
                <span className="deps-label">Depends on</span>
                {dependencyNames.map((dep) => {
                  const depRuntime = runtimeFor(dep.id)
                  return (
                    <button
                      key={dep.id}
                      className={`dep-chip ${depRuntime.status}`}
                      title={`${dep.name} — ${STATUS_LABEL[depRuntime.status]}`}
                      onClick={() => {
                        setActiveId(dep.id)
                        setShowLogs(false)
                      }}
                    >
                      {BUSY.includes(depRuntime.status) && <SpinnerIcon size={9} />}
                      {BROKEN.includes(depRuntime.status) && <AlertIcon size={10} />}
                      {dep.name}
                    </button>
                  )
                })}
              </div>
            )}

            <TerminalHost activeId={activeId} />

            <footer className="statusbar">
              <span>{STATUS_LABEL[activeRuntime.status]}</span>
              {portsOf(activeRuntime).length > 0 && (
                <span>port {portsOf(activeRuntime).join(', ')}</span>
              )}
              {activeRuntime.pid && <span>pid {activeRuntime.pid}</span>}
              {activeRuntime.restartAttempts > 0 && (
                <span>auto-restart attempt {activeRuntime.restartAttempts}</span>
              )}
              <span className="spacer" />
              <code className="truncate">{active.runCommand ?? ''}</code>
            </footer>
          </>
        ) : (
          <div className="placeholder">
            <h1>Runner</h1>
            <p>Add a project to run it here.</p>
            <div className="row">
              <button className="btn primary" onClick={() => setDiscovering(true)}>
                Find my projects
              </button>
              <button className="btn" onClick={() => setEditing({ open: true })}>
                Edit configuration
              </button>
            </div>
          </div>
        )}
      </main>

      {conflictFor && (
        <PortConflictDialog
          project={config.projects.find((p) => p.id === conflictFor) ?? config.projects[0]}
          onClose={() => setConflictFor(null)}
          onEditPorts={() => {
            setEditing({ open: true, id: conflictFor })
            setConflictFor(null)
          }}
        />
      )}

      {discovering && (
        <DiscoverDialog
          onClose={() => setDiscovering(false)}
          onAdded={(next) => {
            setConfig(next)
            setDiscovering(false)
          }}
        />
      )}

      {editing.open && (
        <ConfigEditor
          config={config}
          initialId={editing.id}
          onClose={() => setEditing({ open: false })}
          onSaved={(next) => setConfig(next)}
        />
      )}
    </div>
  )
}
