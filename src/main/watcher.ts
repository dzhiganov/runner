import { watch, type FSWatcher } from 'node:fs'
import { sep } from 'node:path'
import type { ProjectConfig } from '../shared/types.js'
import { expandPath } from './paths.js'

/**
 * How long to wait after the last change before restarting.
 *
 * A save from an editor is several events — the write, the rename of a
 * temporary file, an attribute change — and a build tool touching a directory
 * emits dozens. Restarting on the first would restart several times per save.
 */
const DEBOUNCE_MS = 400

/**
 * Directories never watched into.
 *
 * `node_modules` is the important one: it is enormous, it changes during an
 * install, and nothing in it is the source change anybody means by "restart on
 * file change".
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'target',
  'vendor'
])

/** Files whose changes are noise rather than source edits. */
const IGNORED_FILES = /(^|\/)(\.DS_Store|\.#|~$)|\.(log|swp|swx|tmp)$|~$/

/**
 * True when a path reported by the watcher is worth restarting for.
 *
 * `rootName` is the basename of the watched directory. macOS coalesces nested
 * changes and reports them as the watched directory itself, giving no clue
 * what actually changed — so such an event has to be dropped. Acting on it
 * would mean restarting for `node_modules` churn during an install, which is
 * precisely what the ignore list exists to prevent, and it slips past every
 * other rule here because the directory name looks like an ordinary path.
 *
 * The cost is a missed restart for a file at the project root that happens to
 * share the project directory's exact name. That is worth paying.
 */
export function isInteresting(relative: string, rootName?: string): boolean {
  if (!relative) return false
  if (rootName && relative === rootName) return false
  if (IGNORED_FILES.test(relative)) return false
  for (const segment of relative.split(sep)) {
    if (IGNORED_DIRS.has(segment)) return false
    // Editors write dotfiles constantly; none of them are the source.
    if (segment.startsWith('.') && segment !== '.') return false
  }
  return true
}

/**
 * Restarts projects whose files change.
 *
 * Only watches projects that asked for it, and only while they are running:
 * restarting a stopped project because a file changed would start something
 * the user deliberately stopped.
 */
export class Watcher {
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()
  /** Directory each watcher is on, so a redundant start can be recognised. */
  private watching = new Map<string, string>()

  constructor(private onChange: (projectId: string, path: string) => void) {}

  /**
   * Begins watching `project`, if it is not already being watched.
   *
   * Idempotence is not a nicety here. This is called from the runtime event,
   * which fires every few seconds for port polls and elapsed-time ticks, and
   * tearing the watcher down each time would clear the pending debounce with
   * it — so a file change would only ever restart the project if no runtime
   * update happened to land in the 400ms after it.
   */
  start(project: ProjectConfig): void {
    if (!project.watch) {
      this.stop(project.id)
      return
    }

    const dir = expandPath(project.cwd ?? project.path)
    if (this.watching.get(project.id) === dir) return
    this.stop(project.id)
    try {
      const rootName = dir.split(sep).filter(Boolean).pop()
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const relative = filename.toString()
        if (!isInteresting(relative, rootName)) return
        this.schedule(project.id, relative)
      })
      // A watched directory that is deleted or unmounted should not take the
      // app down with it.
      watcher.on('error', () => this.stop(project.id))
      this.watchers.set(project.id, watcher)
      this.watching.set(project.id, dir)
    } catch {
      // The directory may not exist. Nothing to watch is not an error worth
      // interrupting a start for.
    }
  }

  stop(id: string): void {
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
    this.watching.delete(id)
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
  }

  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.stop(id)
  }

  private schedule(id: string, path: string): void {
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        this.onChange(id, path)
      }, DEBOUNCE_MS)
    )
  }
}
