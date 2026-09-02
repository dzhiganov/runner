import { useEffect, useMemo, useState } from 'react'
import type {
  AutoRestartConfig,
  ConfigValidationIssue,
  ProjectConfig,
  RunnerConfig
} from '@shared/types.js'
import { startOrder } from '@shared/graph.js'
import { BoxIcon } from './Icons.js'

/** Matches the process manager's own fallbacks, so the form shows the truth. */
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RESTART_DELAY_MS = 1000

interface Props {
  config: RunnerConfig
  /** Project to focus when the editor opens. */
  initialId?: string | null
  onClose: () => void
  onSaved: (config: RunnerConfig) => void
}

type Tab = 'form' | 'json'

interface EnvRow {
  key: string
  value: string
}

function portsToText(port?: number[]): string {
  return (port ?? []).join(', ')
}

function textToPorts(text: string): { ports: number[]; error: string | null } {
  const parts = text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const ports: number[] = []
  for (const part of parts) {
    const value = Number(part)
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      return { ports, error: `"${part}" is not a port between 1 and 65535` }
    }
    if (!ports.includes(value)) ports.push(value)
  }
  return { ports, error: null }
}

export default function ConfigEditor({ config, initialId, onClose, onSaved }: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('form')
  const [draft, setDraft] = useState<ProjectConfig[]>(() => structuredClone(config.projects))
  const [selectedId, setSelectedId] = useState<string | null>(
    initialId ?? config.projects[0]?.id ?? null
  )
  const [portText, setPortText] = useState<Record<string, string>>({})
  const [envRows, setEnvRows] = useState<Record<string, EnvRow[]>>({})
  const [json, setJson] = useState('')
  const [issues, setIssues] = useState<ConfigValidationIssue[]>([])
  const [configFile, setConfigFile] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.runner.getConfigPath().then(setConfigFile)
  }, [])

  const selected = useMemo(
    () => draft.find((p) => p.id === selectedId) ?? null,
    [draft, selectedId]
  )

  const portValue = selected ? (portText[selected.id] ?? portsToText(selected.port)) : ''
  const autoRestart = selected?.autoRestart ?? { enabled: false }
  const rows = selected
    ? (envRows[selected.id] ??
      Object.entries(selected.env ?? {}).map(([key, value]) => ({ key, value })))
    : []

  const update = (id: string, changes: Partial<ProjectConfig>): void => {
    setDraft((prev) => prev.map((p) => (p.id === id ? { ...p, ...changes } : p)))
  }

  const updateAutoRestart = (id: string, changes: Partial<AutoRestartConfig>): void => {
    setDraft((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, autoRestart: { enabled: false, ...(p.autoRestart ?? {}), ...changes } }
          : p
      )
    )
  }

  const addProject = async (): Promise<void> => {
    const project = await window.runner.newProject()
    setDraft((prev) => [...prev, project])
    setSelectedId(project.id)
    setTab('form')
  }

  const removeProject = (id: string): void => {
    setDraft((prev) => {
      // A dangling dependency would fail validation on save, so drop the edges
      // pointing at the project along with the project itself.
      const next = prev
        .filter((p) => p.id !== id)
        .map((p) =>
          (p.dependsOn ?? []).includes(id)
            ? { ...p, dependsOn: (p.dependsOn ?? []).filter((dep) => dep !== id) }
            : p
        )
      setSelectedId((current) => (current === id ? (next[0]?.id ?? null) : current))
      return next
    })
  }

  const move = (id: string, delta: number): void => {
    setDraft((prev) => {
      const index = prev.findIndex((p) => p.id === id)
      const target = index + delta
      if (index < 0 || target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  const toggleDependency = (id: string, depId: string): void => {
    setDraft((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p
        const current = p.dependsOn ?? []
        const next = current.includes(depId)
          ? current.filter((value) => value !== depId)
          : [...current, depId]
        return { ...p, dependsOn: next }
      })
    )
  }

  /**
   * Whether depending on `candidate` would close a loop.
   *
   * Checked here as well as on save so the offending checkbox can simply be
   * disabled, which explains the constraint better than an error afterwards.
   */
  const wouldCycle = (project: ProjectConfig, candidateId: string): boolean => {
    if (candidateId === project.id) return true
    return startOrder(draft, candidateId).some((p) => p.id === project.id)
  }

  const setEnvRow = (id: string, index: number, changes: Partial<EnvRow>): void => {
    setEnvRows((prev) => {
      const current =
        prev[id] ??
        Object.entries(draft.find((p) => p.id === id)?.env ?? {}).map(([key, value]) => ({
          key,
          value
        }))
      const next = current.map((row, i) => (i === index ? { ...row, ...changes } : row))
      return { ...prev, [id]: next }
    })
  }

  const addEnvRow = (id: string): void => {
    setEnvRows((prev) => {
      const current =
        prev[id] ??
        Object.entries(draft.find((p) => p.id === id)?.env ?? {}).map(([key, value]) => ({
          key,
          value
        }))
      return { ...prev, [id]: [...current, { key: '', value: '' }] }
    })
  }

  const removeEnvRow = (id: string, index: number): void => {
    setEnvRows((prev) => {
      const current =
        prev[id] ??
        Object.entries(draft.find((p) => p.id === id)?.env ?? {}).map(([key, value]) => ({
          key,
          value
        }))
      return { ...prev, [id]: current.filter((_, i) => i !== index) }
    })
  }

  /** Folds the per-field editing state (port text, services, env rows) back into the draft. */
  const materialize = (): ProjectConfig[] =>
    draft.map((project) => {
      const next: ProjectConfig = { ...project }

      const text = portText[project.id]
      if (text !== undefined) {
        const { ports } = textToPorts(text)
        if (ports.length) next.port = ports
        else delete next.port
      }

      const envDraft = envRows[project.id]
      if (envDraft !== undefined) {
        const env: Record<string, string> = {}
        for (const row of envDraft) {
          const key = row.key.trim()
          if (key) env[key] = row.value
        }
        if (Object.keys(env).length) next.env = env
        else delete next.env
      }

      // An auto-restart block that is off carries no information, and a
      // default attempt count or delay is better left unwritten than frozen
      // into the file where a later change of default would not reach it.
      if (!next.autoRestart?.enabled) delete next.autoRestart
      else {
        const restart = { ...next.autoRestart }
        if (restart.maxAttempts === DEFAULT_MAX_ATTEMPTS) delete restart.maxAttempts
        if (restart.delayMs === DEFAULT_RESTART_DELAY_MS) delete restart.delayMs
        next.autoRestart = restart
      }
      if (!next.autoOpen) delete next.autoOpen

      if (!next.runCommand?.trim()) delete next.runCommand
      if (!next.dependsOn?.length) delete next.dependsOn
      if (next.readiness && !next.readiness.logPattern?.trim() && !next.readiness.port) {
        delete next.readiness
      }
      for (const key of ['shell', 'cwd'] as const) {
        if (!next[key]?.trim()) delete next[key]
      }
      if (next.protocol === 'http') delete next.protocol
      return next
    })

  const switchTab = (next: Tab): void => {
    if (next === 'json' && tab === 'form') {
      setJson(JSON.stringify({ projects: materialize() }, null, 2))
    }
    setIssues([])
    setTab(next)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    const result =
      tab === 'json'
        ? await window.runner.saveConfigRaw(json)
        : await window.runner.saveConfig({ projects: materialize() })
    setSaving(false)
    if (result.ok) {
      onSaved(result.config)
      onClose()
    } else {
      setIssues(result.issues)
    }
  }

  const pickFolder = async (id: string): Promise<void> => {
    const project = draft.find((p) => p.id === id)
    const picked = await window.runner.pickDirectory(project?.path)
    if (picked) update(id, { path: picked })
  }

  const portError = selected ? textToPorts(portValue).error : null

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="editor" onMouseDown={(e) => e.stopPropagation()}>
        <header className="editor-head">
          <div className="tabs">
            <button className={tab === 'form' ? 'tab on' : 'tab'} onClick={() => switchTab('form')}>
              Projects
            </button>
            <button className={tab === 'json' ? 'tab on' : 'tab'} onClick={() => switchTab('json')}>
              Raw JSON
            </button>
          </div>
          <div className="editor-actions">
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </header>

        {issues.length > 0 && (
          <div className="issues">
            {issues.map((issue, i) => (
              <div key={i}>
                {issue.path && <code>{issue.path}</code>} {issue.message}
              </div>
            ))}
          </div>
        )}

        {tab === 'form' ? (
          <div className="editor-body">
            <aside className="editor-list">
              {draft.map((project) => (
                <button
                  key={project.id}
                  className={project.id === selectedId ? 'editor-item on' : 'editor-item'}
                  onClick={() => setSelectedId(project.id)}
                >
                  <BoxIcon size={12} />
                  <span className="truncate">{project.name || 'Untitled'}</span>
                </button>
              ))}
              <button className="editor-item add" onClick={addProject}>
                + Add project
              </button>
            </aside>

            <section className="editor-form">
              {selected ? (
                <>
                  <label className="field">
                    <span>Name</span>
                    <input
                      value={selected.name}
                      onChange={(e) => update(selected.id, { name: e.target.value })}
                      placeholder="my app"
                    />
                  </label>

                  <label className="field">
                    <span>Path</span>
                    <div className="row">
                      <input
                        value={selected.path}
                        onChange={(e) => update(selected.id, { path: e.target.value })}
                        placeholder="~/Documents/projects/my-app"
                      />
                      <button className="btn ghost" onClick={() => pickFolder(selected.id)}>
                        Choose…
                      </button>
                    </div>
                  </label>

                  <label className="field">
                    <span>Run command</span>
                    <input
                      value={selected.runCommand ?? ''}
                      onChange={(e) => update(selected.id, { runCommand: e.target.value })}
                      placeholder="npm run dev"
                    />
                    <small className="hint">
                      Run in your login shell, from the project path, with a free PORT.
                    </small>
                  </label>

                  <label className="field">
                    <span>Ports</span>
                    <input
                      value={portValue}
                      onChange={(e) =>
                        setPortText((prev) => ({ ...prev, [selected.id]: e.target.value }))
                      }
                      placeholder="3000, 3001, 3002"
                    />
                    <small className={portError ? 'hint error' : 'hint'}>
                      {portError ??
                        'Tried in order; the first free one is passed as PORT. If every one is taken, Run is disabled. Leave blank to skip.'}
                    </small>
                  </label>

                  <div className="field">
                    <span>On start</span>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={selected.autoOpen ?? false}
                        onChange={(e) => update(selected.id, { autoOpen: e.target.checked })}
                      />
                      Open in the browser once it answers
                    </label>
                    <small className="hint">
                      Waits for the port to actually accept a connection before opening, so the
                      tab is never pointed at a server that has not finished booting.
                    </small>
                  </div>

                  <div className="field">
                    <span>On crash</span>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={autoRestart.enabled}
                        onChange={(e) => updateAutoRestart(selected.id, { enabled: e.target.checked })}
                      />
                      Restart automatically
                    </label>
                    {autoRestart.enabled && (
                      <div className="row">
                        <label className="inline-field">
                          <span>Attempts</span>
                          <input
                            className="narrow"
                            type="number"
                            min={1}
                            max={100}
                            value={autoRestart.maxAttempts ?? DEFAULT_MAX_ATTEMPTS}
                            onChange={(e) => {
                              const value = Number(e.target.value)
                              updateAutoRestart(selected.id, {
                                maxAttempts:
                                  Number.isInteger(value) && value >= 1 && value <= 100
                                    ? value
                                    : DEFAULT_MAX_ATTEMPTS
                              })
                            }}
                          />
                        </label>
                        <label className="inline-field">
                          <span>First delay (ms)</span>
                          <input
                            className="narrow"
                            type="number"
                            min={100}
                            step={100}
                            value={autoRestart.delayMs ?? DEFAULT_RESTART_DELAY_MS}
                            onChange={(e) => {
                              const value = Number(e.target.value)
                              updateAutoRestart(selected.id, {
                                delayMs:
                                  Number.isFinite(value) && value >= 100
                                    ? Math.round(value)
                                    : DEFAULT_RESTART_DELAY_MS
                              })
                            }}
                          />
                        </label>
                      </div>
                    )}
                    <small className="hint">
                      Only unexpected exits count — a stop you asked for is taken at its word. The
                      delay doubles each attempt, and a run that stays up for 20s earns a fresh
                      budget.
                    </small>
                  </div>

                  <div className="field">
                    <span>Depends on</span>
                    <div className="dep-picker">
                      {draft.filter((p) => p.id !== selected.id).length === 0 && (
                        <small className="hint">Add another project to depend on it.</small>
                      )}
                      {draft
                        .filter((p) => p.id !== selected.id)
                        .map((candidate) => {
                          const checked = (selected.dependsOn ?? []).includes(candidate.id)
                          const cyclic = !checked && wouldCycle(selected, candidate.id)
                          return (
                            <label
                              key={candidate.id}
                              className={cyclic ? 'check disabled' : 'check'}
                              title={
                                cyclic
                                  ? `${candidate.name} already depends on ${selected.name}`
                                  : undefined
                              }
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={cyclic}
                                onChange={() => toggleDependency(selected.id, candidate.id)}
                              />
                              <BoxIcon size={12} />
                              {candidate.name || 'Untitled'}
                            </label>
                          )
                        })}
                    </div>
                    <small className="hint">
                      Runner starts these first and waits for each to answer before starting{' '}
                      {selected.name || 'this project'}.
                    </small>
                  </div>

                  <label className="field">
                    <span>Browser protocol</span>
                    <select
                      value={selected.protocol ?? 'http'}
                      onChange={(e) =>
                        update(selected.id, { protocol: e.target.value as 'http' | 'https' })
                      }
                    >
                      <option value="http">http</option>
                      <option value="https">https</option>
                    </select>
                    <small className="hint">
                      Scheme used by the ↗ link next to a running project.
                    </small>
                  </label>

                  <div className="field">
                    <span>Environment variables</span>
                    <div className="env-rows">
                      {rows.map((row, index) => (
                        <div className="row" key={index}>
                          <input
                            className="env-key"
                            value={row.key}
                            onChange={(e) => setEnvRow(selected.id, index, { key: e.target.value })}
                            placeholder="KEY"
                          />
                          <input
                            value={row.value}
                            onChange={(e) =>
                              setEnvRow(selected.id, index, { value: e.target.value })
                            }
                            placeholder="value"
                          />
                          <button
                            className="btn ghost icon"
                            title="Remove"
                            onClick={() => removeEnvRow(selected.id, index)}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      <button className="btn ghost small" onClick={() => addEnvRow(selected.id)}>
                        + Add variable
                      </button>
                    </div>
                  </div>

                  <details className="advanced">
                    <summary>Advanced</summary>
                    <label className="field">
                      <span>Ready when this appears in the log</span>
                      <input
                        value={selected.readiness?.logPattern ?? ''}
                        onChange={(e) =>
                          update(selected.id, {
                            readiness: { ...(selected.readiness ?? {}), logPattern: e.target.value }
                          })
                        }
                        placeholder="listening on|ready in"
                      />
                      <small className="hint">
                        A regular expression. Only used by projects that depend on this one.
                        Without it, Runner waits for the port to answer.
                      </small>
                    </label>
                    <label className="field">
                      <span>Ready when this port answers</span>
                      <input
                        value={selected.readiness?.port ?? ''}
                        onChange={(e) => {
                          const value = Number(e.target.value)
                          update(selected.id, {
                            readiness: {
                              ...(selected.readiness ?? {}),
                              port: Number.isInteger(value) && value > 0 ? value : undefined
                            }
                          })
                        }}
                        placeholder="5432"
                      />
                    </label>
                    <label className="field">
                      <span>Shell</span>
                      <input
                        value={selected.shell ?? ''}
                        onChange={(e) => update(selected.id, { shell: e.target.value })}
                        placeholder={'defaults to $SHELL'}
                      />
                    </label>
                    <label className="field">
                      <span>Working directory</span>
                      <input
                        value={selected.cwd ?? ''}
                        onChange={(e) => update(selected.id, { cwd: e.target.value })}
                        placeholder="defaults to the project path"
                      />
                    </label>
                  </details>

                  <footer className="form-footer">
                    <button className="btn ghost small" onClick={() => move(selected.id, -1)}>
                      Move up
                    </button>
                    <button className="btn ghost small" onClick={() => move(selected.id, 1)}>
                      Move down
                    </button>
                    <button
                      className="btn danger small"
                      onClick={() => removeProject(selected.id)}
                    >
                      Delete project
                    </button>
                  </footer>
                </>
              ) : (
                <p className="empty">No projects yet. Add one to get started.</p>
              )}
            </section>
          </div>
        ) : (
          <div className="editor-json">
            <textarea
              spellCheck={false}
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
            <small className="hint">{configFile}</small>
          </div>
        )}
      </div>
    </div>
  )
}
