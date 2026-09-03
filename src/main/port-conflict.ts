import { realpathSync } from 'node:fs'
import type {
  PortConflict,
  PortConflictTier,
  PortOwner,
  ProjectConfig
} from '../shared/types.js'
import { expandPath } from './paths.js'
import { isPortFree } from './ports.js'
import { groupIsSafeToKill, whoHolds } from './port-owner.js'

/** How long a killed process is given to let go before the attempt is abandoned. */
const EXIT_TIMEOUT_MS = 6_000
const EXIT_POLL_MS = 150
/** Grace between SIGTERM and SIGKILL, matching what Runner gives its own children. */
const KILL_GRACE_MS = 4_000

/** Resolves symlinks so two spellings of one directory compare equal. */
function canonical(path: string): string {
  const absolute = expandPath(path)
  try {
    return realpathSync(absolute)
  } catch {
    // A path that no longer exists cannot be resolved, but can still match
    // another unresolved spelling of itself.
    return absolute
  }
}

/**
 * The project a process is working in, if any.
 *
 * Matching is on the directory itself or anything beneath it: a dev server run
 * from `packages/web` inside a project configured at its root is still that
 * project's process.
 */
function projectAt(cwd: string | null, projects: ProjectConfig[]): ProjectConfig | null {
  if (!cwd) return null
  const target = canonical(cwd)
  let best: { project: ProjectConfig; length: number } | null = null

  for (const project of projects) {
    const root = canonical(project.cwd ?? project.path)
    if (target !== root && !target.startsWith(`${root}/`)) continue
    // Nested projects: the deepest configured root wins, since it is the more
    // specific claim on the directory.
    if (!best || root.length > best.length) best = { project, length: root.length }
  }
  return best?.project ?? null
}

/**
 * Works out who holds `port` and how much Runner is willing to do about it.
 *
 * `runnerPidFor` reports the pid Runner has recorded for a project, so a
 * process Runner started is recognised as its own even when the pid on the
 * port is a child of the shell it spawned.
 */
export async function classify(
  project: ProjectConfig,
  port: number,
  projects: ProjectConfig[],
  runnerPidFor: (id: string) => number | null,
  alternatives: number[]
): Promise<PortConflict> {
  const owner = await whoHolds(port)
  const match = projectAt(owner?.cwd ?? null, projects)

  let tier: PortConflictTier = 'unknown'
  let ownerProjectId: string | null = null

  if (match) {
    ownerProjectId = match.id
    // Runner's own process is the one it can stop properly — through the
    // orchestrator, with the dependency tree and the auto-restart budget
    // handled — rather than by signalling a pid behind its own back.
    tier = runnerPidFor(match.id) === null ? 'known' : 'runner'
  }

  return {
    projectId: project.id,
    port,
    tier,
    owner,
    ownerProjectName: match?.name ?? null,
    ownerProjectId,
    alternatives
  }
}

/** Waits for a pid to disappear. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!alive(pid)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS))
  }
}

/** Signal 0 tests for existence without delivering anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Delivers a signal to one process, or to its group.
 *
 * The group form negates the *group* id, not the pid. Negating a pid that does
 * not happen to be a group leader names a group that does not exist, the call
 * fails with ESRCH, and nothing is signalled at all — silently, since a failed
 * signal is indistinguishable from a process that already exited.
 */
function signal(owner: PortOwner, sig: NodeJS.Signals, group: boolean): void {
  const target = group && owner.pgid !== null ? -owner.pgid : owner.pid
  try {
    process.kill(target, sig)
  } catch {
    // Already gone, or not ours to signal.
  }
}

/**
 * Terminates an external process holding a port and waits for the port to come
 * back.
 *
 * Never called for the unknown tier: the UI does not offer it, and a process
 * Runner cannot describe is not one it should be killing.
 */
export async function killOwner(
  owner: PortOwner,
  port: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const group = groupIsSafeToKill(owner)

  signal(owner, 'SIGTERM', group)
  if (!(await waitForExit(owner.pid, KILL_GRACE_MS))) {
    signal(owner, 'SIGKILL', group)
    if (!(await waitForExit(owner.pid, EXIT_TIMEOUT_MS - KILL_GRACE_MS))) {
      return { ok: false, reason: `Process ${owner.pid} did not exit.` }
    }
  }

  // The process being gone is not the same as the port being free: a listening
  // socket outlives its process briefly, which is the whole reason restart
  // waits rather than starting immediately.
  const deadline = Date.now() + EXIT_TIMEOUT_MS
  for (;;) {
    if (await isPortFree(port)) return { ok: true }
    if (Date.now() >= deadline) {
      return { ok: false, reason: `Port ${port} is still in use after ${owner.pid} exited.` }
    }
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS))
  }
}

export { projectAt }
