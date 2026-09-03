import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExternalProcess, ProjectConfig, RepoInfo } from '../shared/types.js'
import { expandPath } from './paths.js'
import { projectAt } from './port-conflict.js'

const run = promisify(execFile)

/**
 * Cap on the sweep. Enumerating listeners takes tens of milliseconds on a
 * healthy machine, but `lsof` can block on an unresponsive mount, and a stale
 * answer is better than a sidebar that stops updating.
 */
const SWEEP_TIMEOUT_MS = 4_000

/** Ports below this are system services nobody runs a dev server on. */
const MIN_INTERESTING_PORT = 1024

async function tryRun(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(file, args, { timeout: SWEEP_TIMEOUT_MS })
    return stdout
  } catch {
    return null
  }
}

interface Listener {
  pid: number
  /** lsof's short command name, used only when `ps` will not answer. */
  shortName: string
  ports: Set<number>
}

/**
 * Parses `lsof -F pcn` for every listening socket on the machine.
 *
 * The format is a stream of single-letter-prefixed lines where `p` opens a new
 * process and everything after it belongs to that process until the next `p`.
 */
export function parseListeners(output: string): Listener[] {
  const byPid = new Map<number, Listener>()
  let current: Listener | null = null

  for (const line of output.split('\n')) {
    if (!line) continue
    const tag = line[0]
    const value = line.slice(1)

    if (tag === 'p') {
      const pid = Number(value)
      if (!Number.isInteger(pid) || pid <= 0) {
        current = null
        continue
      }
      current = byPid.get(pid) ?? { pid, shortName: '', ports: new Set() }
      byPid.set(pid, current)
    } else if (tag === 'c' && current) {
      current.shortName = value
    } else if (tag === 'n' && current) {
      // `*:3000`, `127.0.0.1:3000`, `[::1]:3000` — the port is what follows
      // the last colon.
      const port = Number(value.slice(value.lastIndexOf(':') + 1))
      if (Number.isInteger(port) && port >= MIN_INTERESTING_PORT && port <= 65535) {
        current.ports.add(port)
      }
    }
  }

  return [...byPid.values()].filter((listener) => listener.ports.size > 0)
}

/** Full command lines for many pids in one call, keyed by pid. */
async function commandsFor(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (!pids.length) return out

  const stdout = await tryRun('ps', ['-o', 'pid=,command=', '-p', pids.join(',')])
  if (!stdout) return out

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const space = trimmed.indexOf(' ')
    if (space < 0) continue
    const pid = Number(trimmed.slice(0, space))
    if (Number.isInteger(pid)) out.set(pid, trimmed.slice(space + 1))
  }
  return out
}

/** Working directories for many pids in one call, keyed by pid. */
async function cwdsFor(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (!pids.length) return out

  const stdout = await tryRun('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'pn'])
  if (!stdout) return out

  let pid: number | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null) out.set(pid, line.slice(1))
  }
  return out
}

/**
 * Everything listening on this machine that belongs to a configured project
 * and was **not** started by Runner.
 *
 * `isRunnerOwned` decides ownership by project rather than by pid: the process
 * on the port is a grandchild of the login shell Runner spawned, so its pid is
 * not one Runner ever recorded. What Runner does know is which projects it is
 * currently running, and anything in such a project's directory is its own.
 *
 * Processes that match no configured project are dropped. Reporting every
 * listener on the machine would be a system monitor; Runner is answering "is
 * my project already up", which is only meaningful about projects it knows.
 */
export async function sweep(
  projects: ProjectConfig[],
  isRunnerOwned: (projectId: string) => boolean,
  repoFor: (projectId: string) => RepoInfo | null = () => null
): Promise<ExternalProcess[]> {
  const listing = await tryRun('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
  if (!listing) return []

  const listeners = parseListeners(listing)
  const pids = listeners.map((l) => l.pid)
  const [commands, cwds] = await Promise.all([commandsFor(pids), cwdsFor(pids)])

  const found: ExternalProcess[] = []

  for (const listener of listeners) {
    const cwd = cwds.get(listener.pid) ?? null
    const project = projectAt(cwd, projects)
    if (!project) continue
    if (isRunnerOwned(project.id)) continue

    // The worktree is the checkout the process is actually in, which need not
    // be the one configured as the project: a repo's other worktrees share the
    // project's repository but not its directory.
    const repo = repoFor(project.id)
    const here = cwd ? expandPath(cwd) : null
    const worktree =
      repo?.worktrees.find((w) => here === w.path || here?.startsWith(`${w.path}/`)) ?? null

    found.push({
      pid: listener.pid,
      command: commands.get(listener.pid) ?? (listener.shortName || 'unknown'),
      cwd,
      ports: [...listener.ports].sort((a, b) => a - b),
      projectId: project.id,
      worktreePath: worktree?.path ?? null,
      branch: worktree?.branch ?? null
    })
  }

  return found
}
