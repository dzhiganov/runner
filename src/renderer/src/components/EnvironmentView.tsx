import { useMemo } from 'react'
import type {
  ExternalProcess,
  ProjectConfig,
  ProjectGit,
  ProjectResources,
  ProjectRuntime
} from '@shared/types.js'
import { AlertIcon, BranchIcon, BoxIcon, ExternalLinkIcon, SpinnerIcon } from './Icons.js'
import { group, LOOSE } from '@shared/environment.js'

interface Props {
  projects: ProjectConfig[]
  git: Record<string, ProjectGit>
  runtimeFor: (id: string) => ProjectRuntime
  isLive: (id: string) => boolean
  externals: Record<string, ExternalProcess>
  resources: Record<string, ProjectResources>
  onSelect: (id: string) => void
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`
}

export default function EnvironmentView({
  projects,
  git,
  runtimeFor,
  isLive,
  externals,
  resources,
  onSelect
}: Props): React.JSX.Element {
  const groups = useMemo(() => group(projects, git), [projects, git])

  const totals = useMemo(() => {
    const values = Object.values(resources)
    return {
      running: values.length,
      cpu: values.reduce((n, r) => n + r.cpu, 0),
      memory: values.reduce((n, r) => n + r.memoryBytes, 0)
    }
  }, [resources])

  if (!projects.length) {
    return (
      <div className="env">
        <p className="env-empty">Nothing configured yet.</p>
      </div>
    )
  }

  return (
    <div className="env">
      <div className="env-body">
        {groups.map((repo) => (
          <section className="env-repo" key={repo.key}>
            <header className="env-repo-head">
              <strong>{repo.name}</strong>
              {/* RTL container so a long path ellipsises at the front, where
                  the uninteresting shared prefix is; the LRM keeps the text
                  itself laid out left-to-right. */}
              {repo.root && (
                <span className="env-path truncate" title={repo.root}>
                  {'\u200e'}
                  {repo.root}
                </span>
              )}
            </header>

            {repo.worktrees.map((worktree) => {
              // Git state belongs to the worktree, so it is read from any
              // project in it — they are all the same checkout.
              const status = git[worktree.projects[0].id]?.status
              return (
                <div className="env-worktree" key={worktree.path ?? 'none'}>
                  {worktree.branch && (
                    <div className="env-branch-row">
                      <BranchIcon size={12} />
                      <span className="env-branch">{worktree.branch}</span>
                      {status && !status.clean && (
                        <span className="dirt">
                          ✎{status.changed + status.untracked}
                        </span>
                      )}
                      {status?.ahead ? <span className="dirt">↑{status.ahead}</span> : null}
                      {status?.behind ? <span className="dirt">↓{status.behind}</span> : null}
                      {status?.clean && <span className="env-clean">clean</span>}
                    </div>
                  )}

                  <div className="env-services">
                    {worktree.projects.map((project) => {
                      const runtime = runtimeFor(project.id)
                      const live = isLive(project.id)
                      const external = externals[project.id]
                      const ports = live
                        ? runtime.detectedPorts.length
                          ? runtime.detectedPorts
                          : runtime.port === null
                            ? []
                            : [runtime.port]
                        : (external?.ports ?? [])
                      const usage = resources[project.id]

                      return (
                        <button
                          className="env-service"
                          key={project.id}
                          onClick={() => onSelect(project.id)}
                        >
                          <span
                            className={`dot ${
                              live ? 'running' : external ? 'external' : ''
                            } ${runtime.status === 'exited' || runtime.status === 'error' ? 'broken' : ''}`}
                          />
                          <span className="env-name truncate">{project.name}</span>
                          <span className="env-ports">
                            {ports.length ? ports.map((p) => `:${p}`).join(' ') : '—'}
                          </span>
                          <span className="env-owner">
                            {live ? 'Runner' : external ? 'External' : 'stopped'}
                          </span>
                          <span className="env-usage">
                            {usage ? `${usage.cpu.toFixed(0)}% · ${formatBytes(usage.memoryBytes)}` : ''}
                          </span>
                          {(runtime.status === 'exited' || runtime.status === 'error') && (
                            <AlertIcon size={12} className="broken" />
                          )}
                          {['starting', 'waiting', 'stopping'].includes(runtime.status) && (
                            <SpinnerIcon size={12} className="busy" />
                          )}
                          {ports.length > 0 && (
                            <span
                              className="env-open"
                              title={`Open :${ports[0]}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                void window.runner.openExternal(
                                  `${project.protocol ?? 'http'}://localhost:${ports[0]}`
                                )
                              }}
                            >
                              <ExternalLinkIcon size={11} />
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </section>
        ))}
      </div>

      <footer className="statusbar">
        <span>
          <BoxIcon size={12} /> {projects.length} {projects.length === 1 ? 'project' : 'projects'}
        </span>
        <span>
          {groups.filter((g) => g.key !== LOOSE).length} repositories
        </span>
        {totals.running > 0 && (
          <span>
            {totals.running} running · {totals.cpu.toFixed(0)}% cpu · {formatBytes(totals.memory)}
          </span>
        )}
      </footer>
    </div>
  )
}
