import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredProject, PackageManager } from '../shared/types.js'
import { expandPath } from './paths.js'

/**
 * How deep below a scan root a project may sit.
 *
 * `~/Projects/api` is depth 1, `~/Projects/work/api` is depth 2. Going deeper
 * finds little beyond the occasional nested example app and costs a full walk
 * of every `node_modules` sibling on the way down, so it stops here.
 */
const MAX_DEPTH = 2

/** Never descended into: large, uninteresting, or both. */
const SKIP_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'tmp',
  'Library',
  'Applications'
])

/** Lockfile → package manager, in the order they are tested. */
const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm']
]

/**
 * Scripts worth offering as a run command, best first.
 *
 * A dev-server manager wants the long-running one, so `dev` beats `start`, and
 * anything that obviously exits (`build`, `test`, `lint`) is not a candidate
 * for the primary suggestion even though it is still listed.
 */
const PREFERRED_SCRIPTS = ['dev', 'start', 'serve', 'develop', 'watch']

/** Scripts never suggested as the primary command — they exit immediately. */
const ONE_SHOT_SCRIPTS = new Set(['build', 'test', 'lint', 'format', 'typecheck', 'ci'])

/**
 * True when `dir` is inside a git repository, as either a normal clone or a
 * linked worktree.
 *
 * In a normal clone `.git` is a directory. In a worktree checkout it is a
 * *file* containing `gitdir: …`. Testing for a directory would silently skip
 * every worktree, which is the whole reason worktree checkouts are worth
 * discovering in the first place.
 */
function hasGit(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/** The package manager this project uses, from whichever lockfile it has. */
function detectPackageManager(dir: string): PackageManager | null {
  for (const [file, manager] of LOCKFILES) {
    if (existsSync(join(dir, file))) return manager
  }
  return null
}

/** `npm run dev`, `pnpm dev`, … — how each manager actually spells it. */
function commandFor(manager: PackageManager, script: string): string {
  if (manager === 'npm') return `npm run ${script}`
  return `${manager} ${script}`
}

interface PackageJson {
  name?: string
  scripts?: Record<string, string>
}

function readPackageJson(dir: string): PackageJson | null {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as PackageJson
  } catch {
    // A package.json that does not parse still marks a project directory; it
    // just cannot contribute a name or any commands.
    return null
  }
}

/**
 * Inspects one directory. Returns null when it is not a project.
 *
 * A directory counts as a project when it has `.git` or a `package.json` —
 * deliberately loose, because the cost of offering a directory the user then
 * unticks is far lower than the cost of silently missing one they wanted.
 */
export function inspect(dir: string): DiscoveredProject | null {
  const git = hasGit(dir)
  // Existence and parseability are separate questions: a package.json that
  // does not parse still marks a Node project, it just cannot say anything
  // about itself. Conflating the two would label such a directory as if it
  // were a bare git repo.
  const hasPkg = existsSync(join(dir, 'package.json'))
  const pkg = readPackageJson(dir)
  if (!git && !hasPkg) return null

  const manager = detectPackageManager(dir)
  const scripts = pkg?.scripts ?? {}
  const names = Object.keys(scripts)

  // Without a lockfile there is nothing trustworthy to prefix a script with,
  // so the commands list stays empty rather than guessing npm.
  const commands = manager ? names.map((script) => commandFor(manager, script)) : []
  const preferred = manager
    ? (PREFERRED_SCRIPTS.find((script) => names.includes(script)) ??
      names.find((script) => !ONE_SHOT_SCRIPTS.has(script)))
    : undefined

  return {
    name: (pkg?.name?.trim() || dir.split('/').filter(Boolean).pop()) ?? dir,
    path: dir,
    displayPath: tildify(dir),
    hasGit: git,
    hasPackageJson: hasPkg,
    packageManager: manager,
    commands,
    suggestedCommand: preferred && manager ? commandFor(manager, preferred) : null
  }
}

/** Directory entries worth descending into: real, readable, not noise. */
function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => {
        if (entry.name.startsWith('.')) return false
        if (SKIP_DIRS.has(entry.name)) return false
        if (entry.isDirectory()) return true
        // Symlinked project folders are common in monorepo setups.
        if (!entry.isSymbolicLink()) return false
        try {
          return statSync(join(dir, entry.name)).isDirectory()
        } catch {
          return false
        }
      })
      .map((entry) => join(dir, entry.name))
  } catch {
    // Unreadable directory — a permissions boundary, or it vanished mid-scan.
    return []
  }
}

/**
 * Walks one root, collecting projects.
 *
 * A directory that is itself a project is not descended into. A monorepo's
 * `packages/*` are part of the repo, not eight separate things to add, and
 * stopping at the boundary is what keeps the result list short enough to read.
 */
function walk(dir: string, depth: number, found: DiscoveredProject[]): void {
  const project = inspect(dir)
  if (project) {
    found.push(project)
    return
  }
  if (depth >= MAX_DEPTH) return
  for (const child of childDirs(dir)) walk(child, depth + 1, found)
}

/**
 * Scans every root and returns what it found, minus anything already
 * configured.
 *
 * Excluding known paths is what makes a re-scan useful: it answers "what is
 * new since last time" rather than re-listing the projects already added.
 */
export function scan(roots: string[], knownPaths: string[] = []): DiscoveredProject[] {
  const known = new Set(knownPaths.map((path) => expandPath(path)))
  const seen = new Set<string>()
  const found: DiscoveredProject[] = []

  for (const root of roots) {
    const absolute = expandPath(root)
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(absolute)
    } catch {
      continue
    }
    if (!stats.isDirectory()) continue

    const fromRoot: DiscoveredProject[] = []
    walk(absolute, 0, fromRoot)
    for (const project of fromRoot) {
      if (known.has(project.path) || seen.has(project.path)) continue
      seen.add(project.path)
      found.push(project)
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** Roots offered on first use: the folders people actually keep code in. */
export function defaultRoots(): string[] {
  return ['~/Projects', '~/Documents/projects', '~/Work', '~/Code', '~/src', '~/dev'].filter(
    (candidate) => {
      try {
        return statSync(expandPath(candidate)).isDirectory()
      } catch {
        return false
      }
    }
  )
}

/**
 * The command to configure when a scan found nothing to suggest.
 *
 * Validation requires every project to have a `runCommand`, so a project with
 * no recognisable script still needs one to be addable at all. This is a
 * placeholder for the user to correct, matching what the "New project" button
 * already fills in, not a claim that the script exists.
 */
export function fallbackCommand(manager: PackageManager | null): string {
  return commandFor(manager ?? 'npm', 'dev')
}

/** Writes a path back in `~` form, so the saved config stays portable. */
export function tildify(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
