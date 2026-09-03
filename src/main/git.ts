import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitStatus, RepoInfo, Worktree } from '../shared/types.js'
import { expandPath } from './paths.js'

const run = promisify(execFile)

/**
 * Cap on every git call. Git on a cold or network-backed repository can take
 * seconds, and a sidebar that blocks on it is worse than one that says nothing
 * about the branch.
 */
const GIT_TIMEOUT_MS = 3_000

/**
 * How long a repository's worktree list is reused.
 *
 * Worktrees are created and removed by hand, minutes or days apart — not
 * something worth re-reading on every render. Branch state changes far more
 * often and is read separately, on its own shorter cycle.
 */
const REPO_TTL_MS = 15_000

/**
 * How long working-copy state is reused.
 *
 * Far shorter than the repository TTL: a branch is switched and files are
 * edited constantly, where worktrees are created by hand days apart. Sharing
 * one cache between the two would either re-shell for worktrees far too often
 * or show a dirty count minutes out of date.
 */
const STATUS_TTL_MS = 2_500

interface Cached<T> {
  at: number
  value: T
}

const cache = new Map<string, Cached<RepoInfo | null>>()
const statusCache = new Map<string, Cached<GitStatus | null>>()

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: GIT_TIMEOUT_MS })
    return stdout
  } catch {
    // Not a repository, git not installed, or the directory is gone. All three
    // mean the same thing to a caller: no git information available.
    return null
  }
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * Records are blank-line separated. Each opens with `worktree <path>`, then
 * `HEAD <sha>`, then either `branch refs/heads/<name>` or the bare word
 * `detached`. `bare`, `locked` and `prunable` may also appear.
 */
export function parseWorktrees(output: string): Worktree[] {
  const worktrees: Worktree[] = []
  let current: Partial<Worktree> & { bare?: boolean } = {}

  const flush = (): void => {
    // A bare repository has no working copy to run anything in, so it is not
    // something Runner can offer.
    if (current.path && !current.bare) {
      worktrees.push({
        path: current.path,
        head: current.head ?? null,
        branch: current.branch ?? null,
        detached: current.detached ?? false,
        locked: current.locked ?? false
      })
    }
    current = {}
  }

  for (const line of output.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed) {
      flush()
      continue
    }
    if (trimmed.startsWith('worktree ')) current.path = trimmed.slice(9)
    else if (trimmed.startsWith('HEAD ')) current.head = trimmed.slice(5)
    else if (trimmed.startsWith('branch ')) current.branch = trimmed.slice(7).replace(/^refs\/heads\//, '')
    else if (trimmed === 'detached') current.detached = true
    else if (trimmed === 'bare') current.bare = true
    else if (trimmed === 'locked' || trimmed.startsWith('locked ')) current.locked = true
  }
  flush()

  return worktrees
}

/**
 * The repository a directory belongs to, and every worktree of it.
 *
 * Identity is the common git directory, not the working copy path: that is
 * what two checkouts of one repository actually share, and it is what lets
 * Runner say "these three projects are the same repo on different branches"
 * rather than listing them as unrelated.
 */
export async function repoInfo(dir: string): Promise<RepoInfo | null> {
  const cwd = expandPath(dir)

  const cached = cache.get(cwd)
  if (cached && Date.now() - cached.at < REPO_TTL_MS) return cached.value

  const commonDir = (
    await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  )?.trim()

  let value: RepoInfo | null = null
  if (commonDir) {
    const listing = await git(cwd, ['worktree', 'list', '--porcelain'])
    const worktrees = listing ? parseWorktrees(listing) : []
    value = {
      // The main worktree is the first record git prints.
      root: worktrees[0]?.path ?? cwd,
      commonDir,
      // The repository's name is its main working copy's directory, which is
      // what a person calls it — not `.git`, which every repo is called.
      name: (worktrees[0]?.path ?? cwd).split('/').filter(Boolean).pop() ?? cwd,
      worktrees
    }
  }

  cache.set(cwd, { at: Date.now(), value })
  return value
}

/**
 * Parses `git status --porcelain=v2 --branch`.
 *
 * Header lines are `# branch.<field> <value>`. Entries that follow are one per
 * path: `1` ordinary changes, `2` renames and copies, `u` unmerged, `?`
 * untracked. Everything but `?` counts as a change to a tracked file.
 */
export function parseStatus(output: string): GitStatus {
  let branch: string | null = null
  let detached = false
  let ahead: number | null = null
  let behind: number | null = null
  let changed = 0
  let untracked = 0

  for (const line of output.split('\n')) {
    if (!line) continue

    if (line.startsWith('# branch.head ')) {
      const value = line.slice(14).trim()
      // git spells a detached head `(detached)`, which is not a branch name.
      if (value === '(detached)') detached = true
      else branch = value
    } else if (line.startsWith('# branch.ab ')) {
      // `+2 -1`. Absent entirely when the branch has no upstream, which is why
      // both counts start as null rather than zero.
      const match = line.slice(12).trim().match(/^\+(\d+)\s+-(\d+)$/)
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
    } else if (line.startsWith('#')) {
      continue
    } else if (line.startsWith('? ')) {
      untracked += 1
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      changed += 1
    }
  }

  return { branch, detached, ahead, behind, changed, untracked, clean: changed === 0 && untracked === 0 }
}

/** Working-copy state of the checkout at `dir`, or null when it is not one. */
export async function gitStatus(dir: string): Promise<GitStatus | null> {
  const cwd = expandPath(dir)

  const cached = statusCache.get(cwd)
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value

  const output = await git(cwd, ['status', '--porcelain=v2', '--branch'])
  const value = output === null ? null : parseStatus(output)
  statusCache.set(cwd, { at: Date.now(), value })
  return value
}

/** Drops cached repository and working-copy information. */
export function forgetRepos(): void {
  cache.clear()
  statusCache.clear()
}
