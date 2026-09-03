import { useEffect, useState } from 'react'
import type { PortConflict, ProjectConfig } from '@shared/types.js'
import { AlertIcon, SpinnerIcon } from './Icons.js'

interface Props {
  project: ProjectConfig
  onClose: () => void
  /** Opens the config editor on this project, for changing the port list. */
  onEditPorts: () => void
}

const TIER_LABEL: Record<PortConflict['tier'], string> = {
  runner: 'Started by Runner',
  known: 'Another project',
  unknown: 'Unknown process'
}

const TIER_MARK: Record<PortConflict['tier'], string> = {
  runner: '🟢',
  known: '🟡',
  unknown: '🔴'
}

export default function PortConflictDialog({
  project,
  onClose,
  onEditPorts
}: Props): React.JSX.Element {
  const [conflicts, setConflicts] = useState<PortConflict[] | null>(null)
  const [working, setWorking] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.runner.inspectPorts(project.id).then((found) => {
      if (cancelled) return
      setConflicts(found)
      // The port came free between the click and the lookup; nothing to resolve.
      if (found.length === 0) onClose()
    })
    return () => {
      cancelled = true
    }
  }, [project.id, onClose])

  const resolve = async (conflict: PortConflict): Promise<void> => {
    setWorking(conflict.port)
    setError(null)
    try {
      const result = await window.runner.resolvePortConflict(conflict)
      if (result.ok) onClose()
      else setError(result.message ?? 'Could not free the port.')
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="editor conflict" onMouseDown={(e) => e.stopPropagation()}>
        <header className="editor-head">
          <strong>
            {conflicts === null
              ? 'Checking ports…'
              : conflicts.length === 1
                ? `Port ${conflicts[0].port} is already in use`
                : `${conflicts.length} of ${project.port?.length ?? 0} ports are in use`}
          </strong>
          <div className="editor-actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </header>

        {error && (
          <div className="issues">
            <AlertIcon size={12} /> {error}
          </div>
        )}

        <div className="conflict-body">
          {conflicts === null && (
            <p className="discover-empty">
              <SpinnerIcon size={13} className="busy" /> Asking the system who holds them…
            </p>
          )}

          {conflicts?.map((conflict) => (
            <section className={`conflict-row ${conflict.tier}`} key={conflict.port}>
              <div className="conflict-port">
                <strong>:{conflict.port}</strong>
                <span className="conflict-tier">
                  {TIER_MARK[conflict.tier]} {TIER_LABEL[conflict.tier]}
                </span>
              </div>

              <div className="conflict-owner">
                {conflict.owner ? (
                  <>
                    {conflict.ownerProjectName && (
                      <div className="conflict-project">{conflict.ownerProjectName}</div>
                    )}
                    <code className="conflict-cmd">{conflict.owner.command}</code>
                    <div className="conflict-meta">
                      PID {conflict.owner.pid}
                      {conflict.owner.cwd && <> · {conflict.owner.cwd}</>}
                    </div>
                  </>
                ) : (
                  <div className="conflict-meta">
                    Something is listening, but the system would not say what. This
                    usually means it belongs to another user.
                  </div>
                )}
              </div>

              <div className="conflict-actions">
                {conflict.tier === 'unknown' ? (
                  <span className="conflict-refused">No kill offered</span>
                ) : (
                  <button
                    className="btn primary small"
                    disabled={working !== null}
                    onClick={() => void resolve(conflict)}
                  >
                    {working === conflict.port
                      ? 'Freeing…'
                      : conflict.tier === 'runner'
                        ? 'Stop & Start'
                        : 'Kill & Start'}
                  </button>
                )}
              </div>
            </section>
          ))}
        </div>

        <footer className="conflict-foot">
          <button className="btn" onClick={onEditPorts}>
            Edit port list
          </button>
          <span className="muted">
            {conflicts?.some((c) => c.tier === 'unknown')
              ? 'Runner will not kill a process it cannot identify.'
              : 'Stopping frees the port, then the project starts.'}
          </span>
        </footer>
      </div>
    </div>
  )
}
