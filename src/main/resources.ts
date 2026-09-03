import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProjectResources } from '../shared/types.js'

const run = promisify(execFile)

const SAMPLE_TIMEOUT_MS = 3_000

export interface PsRow {
  pid: number
  ppid: number
  cpu: number
  /** Resident set size in kilobytes, as `ps` reports it. */
  rssKb: number
}

/**
 * Parses `ps -eo pid=,ppid=,pcpu=,rss=`.
 *
 * `pcpu` is printed with the locale's decimal separator, so on a machine set to
 * a comma locale every reading arrives as `0,0` and `Number()` returns NaN.
 * Normalising it is not optional — without it every project reports NaN% CPU
 * on a large share of machines, and reads as a bug in the sampling rather than
 * in the parsing.
 */
export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = []

  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue

    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const cpu = Number(parts[2].replace(',', '.'))
    const rssKb = Number(parts[3])

    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    rows.push({
      pid,
      ppid,
      cpu: Number.isFinite(cpu) ? cpu : 0,
      rssKb: Number.isFinite(rssKb) ? rssKb : 0
    })
  }
  return rows
}

/**
 * Every descendant of `root`, including it.
 *
 * This is the point of the whole module. Runner's child is a login shell; the
 * CPU and memory that actually hurt belong to the `node` processes beneath it,
 * so sampling only the direct child would report a few megabytes and be
 * useless.
 */
export function descendants(rows: PsRow[], root: number): PsRow[] {
  const children = new Map<number, PsRow[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }

  const found: PsRow[] = []
  const seen = new Set<number>()
  const queue = [root]

  while (queue.length) {
    const pid = queue.shift()!
    // A pid cycle should be impossible, but a sampling loop is not the place
    // to find out the hard way.
    if (seen.has(pid)) continue
    seen.add(pid)

    const self = rows.find((row) => row.pid === pid)
    if (self) found.push(self)
    for (const child of children.get(pid) ?? []) queue.push(child.pid)
  }

  return found
}

/** Sums a process tree per project, from one `ps` of the whole machine. */
export function summarise(rows: PsRow[], pids: Map<string, number>): ProjectResources[] {
  const out: ProjectResources[] = []

  for (const [projectId, pid] of pids) {
    const tree = descendants(rows, pid)
    if (!tree.length) continue
    out.push({
      projectId,
      cpu: Math.round(tree.reduce((sum, row) => sum + row.cpu, 0) * 10) / 10,
      memoryBytes: tree.reduce((sum, row) => sum + row.rssKb, 0) * 1024,
      processes: tree.length
    })
  }
  return out
}

/** One sample of every running project's resource use. */
export async function sample(pids: Map<string, number>): Promise<ProjectResources[]> {
  if (!pids.size) return []
  try {
    const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,pcpu=,rss='], {
      timeout: SAMPLE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024
    })
    return summarise(parsePs(stdout), pids)
  } catch {
    return []
  }
}
