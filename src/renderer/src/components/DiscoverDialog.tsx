import { useCallback, useEffect, useState } from 'react'
import type { ConfigValidationIssue, DiscoveredProject, RunnerConfig } from '@shared/types.js'
import { BoxIcon, SpinnerIcon } from './Icons.js'

interface Props {
  onClose: () => void
  onAdded: (config: RunnerConfig) => void
}

/** How a detected project describes itself in one line under its name. */
function subtitle(project: DiscoveredProject): string {
  const parts: string[] = []
  if (project.hasPackageJson) parts.push('Node.js')
  if (project.packageManager) parts.push(project.packageManager)
  if (project.hasGit && !project.hasPackageJson) parts.push('Git repository')
  return parts.join(' · ')
}

export default function DiscoverDialog({ onClose, onAdded }: Props): React.JSX.Element {
  const [roots, setRoots] = useState<string[]>([])
  const [found, setFound] = useState<DiscoveredProject[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [issues, setIssues] = useState<ConfigValidationIssue[]>([])

  const runScan = useCallback(async (which: string[]): Promise<void> => {
    if (!which.length) {
      setFound([])
      return
    }
    setScanning(true)
    setIssues([])
    try {
      const results = await window.runner.scanProjects(which)
      setFound(results)
      // Anything with a command Runner can suggest is ticked by default; the
      // rest need a decision, so they start unticked rather than importing a
      // project that cannot run.
      setPicked(new Set(results.filter((p) => p.suggestedCommand).map((p) => p.path)))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    window.runner.getScanRoots().then((initial) => {
      setRoots(initial)
      void runScan(initial)
    })
  }, [runScan])

  const addRoot = async (): Promise<void> => {
    const chosen = await window.runner.pickDirectory()
    if (!chosen || roots.includes(chosen)) return
    const next = [...roots, chosen]
    setRoots(next)
    await window.runner.saveScanRoots(next)
    void runScan(next)
  }

  const removeRoot = async (root: string): Promise<void> => {
    const next = roots.filter((r) => r !== root)
    setRoots(next)
    await window.runner.saveScanRoots(next)
    void runScan(next)
  }

  const toggle = (path: string): void => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleAll = (): void => {
    if (!found) return
    setPicked((prev) => (prev.size === found.length ? new Set() : new Set(found.map((p) => p.path))))
  }

  const add = async (): Promise<void> => {
    if (!found || !picked.size) return
    setSaving(true)
    try {
      const result = await window.runner.addDiscovered(found.filter((p) => picked.has(p.path)))
      if (result.ok) onAdded(result.config)
      else setIssues(result.issues)
    } finally {
      setSaving(false)
    }
  }

  const count = found?.length ?? 0

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="editor discover" onMouseDown={(e) => e.stopPropagation()}>
        <header className="editor-head">
          <strong>
            {scanning
              ? 'Scanning…'
              : found === null
                ? 'Discover projects'
                : `${count} ${count === 1 ? 'project' : 'projects'} found`}
          </strong>
          <div className="editor-actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!picked.size || saving} onClick={add}>
              {saving ? 'Adding…' : `Add ${picked.size || ''}`.trim()}
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

        <div className="discover-roots">
          <span className="field-label">Folders scanned</span>
          <div className="chips">
            {roots.map((root) => (
              <span className="chip" key={root}>
                {root}
                <button
                  className="chip-x"
                  onClick={() => void removeRoot(root)}
                  title={`Stop scanning ${root}`}
                >
                  ×
                </button>
              </span>
            ))}
            <button className="btn small" onClick={() => void addRoot()}>
              Add folder…
            </button>
          </div>
        </div>

        <div className="discover-body">
          {scanning && (
            <p className="discover-empty">
              <SpinnerIcon size={13} className="busy" /> Looking through {roots.length}{' '}
              {roots.length === 1 ? 'folder' : 'folders'}…
            </p>
          )}

          {!scanning && found !== null && count === 0 && (
            <p className="discover-empty">
              {roots.length === 0
                ? 'No folders to scan yet. Add one above.'
                : 'Nothing new here — everything found is already in Runner.'}
            </p>
          )}

          {!scanning &&
            found?.map((project) => (
              <label className="discover-item" key={project.path}>
                <input
                  type="checkbox"
                  checked={picked.has(project.path)}
                  onChange={() => toggle(project.path)}
                />
                <BoxIcon size={13} />
                <span className="discover-text">
                  <span className="discover-name truncate">{project.name}</span>
                  <span className="discover-meta truncate">{subtitle(project)}</span>
                  <span className="discover-path truncate-left" title={project.path}>
                    {/*
                      The container is RTL so the ellipsis lands on the left. A
                      leading LRM keeps the text itself laid out left-to-right;
                      without it the path's own leading slash is reordered to
                      the end and reads as a trailing one.
                    */}
                    {'\u200e'}
                    {project.displayPath}
                  </span>
                </span>
                <code className="discover-cmd truncate">
                  {project.suggestedCommand ?? 'no command found — set one after adding'}
                </code>
              </label>
            ))}
        </div>

        {count > 0 && !scanning && (
          <footer className="discover-foot">
            <button className="btn link" onClick={toggleAll}>
              {picked.size === count ? 'Select none' : 'Select all'}
            </button>
            <span className="muted">Ports are not assigned — set them per project afterwards.</span>
          </footer>
        )}
      </div>
    </div>
  )
}
