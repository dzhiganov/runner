import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PortOwner } from '../shared/types.js'

const run = promisify(execFile)

/**
 * Cap on every probe. `lsof` can block on an unresponsive network mount, and a
 * conflict dialog that never opens is worse than one that admits it does not
 * know who holds the port.
 */
const PROBE_TIMEOUT_MS = 2_500

/** Runs a command, resolving to null rather than throwing on any failure. */
async function tryRun(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(file, args, { timeout: PROBE_TIMEOUT_MS })
    return stdout
  } catch {
    // A non-zero exit is the normal answer for "nothing matched", and lsof is
    // not guaranteed to exist. Both mean the same thing here: no answer.
    return null
  }
}

/**
 * Parses `lsof -F` output, which is one field per line, each prefixed by a
 * single letter naming it: `p` for pid, `c` for command, `n` for name.
 */
function field(output: string, letter: string): string | null {
  for (const line of output.split('\n')) {
    if (line.startsWith(letter) && line.length > 1) return line.slice(1)
  }
  return null
}

/** The full command line of a pid, which `lsof` only reports abbreviated. */
async function commandOf(pid: number): Promise<string | null> {
  const out = await tryRun('ps', ['-o', 'command=', '-p', String(pid)])
  return out?.trim() || null
}

/** A process's working directory — the only thing that ties it to a project. */
async function cwdOf(pid: number): Promise<string | null> {
  const out = await tryRun('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-F', 'n'])
  return out ? field(out, 'n') : null
}

/** A process's group id, for deciding whether a group kill is safe. */
async function pgidOf(pid: number): Promise<number | null> {
  const out = await tryRun('ps', ['-o', 'pgid=', '-p', String(pid)])
  const value = Number(out?.trim())
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Who is listening on `port`, as far as the OS will say.
 *
 * Returns null when nothing holds it, when `lsof` is unavailable, or when the
 * process belongs to another user and is not ours to inspect. A null answer is
 * a legitimate outcome, not an error: it lands the conflict in the "unknown"
 * tier, which is exactly where a process we cannot describe belongs.
 */
export async function whoHolds(port: number): Promise<PortOwner | null> {
  const listing = await tryRun('lsof', [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-F', 'pc'
  ])
  if (!listing) return null

  const pid = Number(field(listing, 'p'))
  if (!Number.isInteger(pid) || pid <= 0) return null

  const [command, cwd, pgid] = await Promise.all([commandOf(pid), cwdOf(pid), pgidOf(pid)])

  return {
    pid,
    // `lsof`'s abbreviated name is a poor last resort, but naming the process
    // at all is better than showing a bare pid.
    command: command ?? field(listing, 'c') ?? 'unknown',
    cwd,
    pgid
  }
}

/**
 * Whether the whole process group can be signalled rather than just the one
 * process.
 *
 * Only when the listener is its own group leader. A group it merely belongs to
 * is somebody else's — an interactive shell's job, a parent script, a test
 * runner — and killing it because a port was busy would take down far more
 * than the dev server that was asked about.
 *
 * A "does the leader share the listener's directory?" test was tried first and
 * is not safe: a shell sitting in the project directory passes it, and so does
 * any parent process started from there. The cost of being wrong is unbounded;
 * the cost of being conservative is that `npm run dev` may leave the npm
 * wrapper behind after its child is killed, which npm handles by exiting.
 */
export function groupIsSafeToKill(owner: PortOwner): boolean {
  return owner.pgid !== null && owner.pgid === owner.pid
}
