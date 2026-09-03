import type { ProjectConfig, ProjectGit } from './types.js'

/** A repository, or the pseudo-group holding everything not in one. */
export interface EnvGroup {
  key: string
  name: string
  /** Null for the ungrouped bucket. */
  root: string | null
  worktrees: { path: string | null; branch: string | null; projects: ProjectConfig[] }[]
}

/** Key of the bucket for projects that are not in a repository at all. */
export const LOOSE = '__loose__'

/**
 * Groups projects by repository, then by the worktree each is checked out in.
 *
 * Repositories are keyed by their common git directory, so two worktrees of
 * one repo land in the same group despite being different directories — the
 * whole reason the environment view is worth having.
 *
 * Projects that are not in a repository still have to appear. They are
 * perfectly valid, just not part of this structure, so they collect in one
 * bucket that sorts last rather than being dropped from the view.
 */
export function group(projects: ProjectConfig[], git: Record<string, ProjectGit>): EnvGroup[] {
  const byRepo = new Map<string, EnvGroup>()

  for (const project of projects) {
    const info = git[project.id]
    const key = info?.repo?.commonDir ?? LOOSE

    let entry = byRepo.get(key)
    if (!entry) {
      entry = {
        key,
        name: info?.repo?.name ?? 'Not in a repository',
        root: info?.repo?.root ?? null,
        worktrees: []
      }
      byRepo.set(key, entry)
    }

    const path = info?.worktree?.path ?? null
    // Prefer the live status branch over the worktree listing's: the listing
    // is cached far longer, so it is the one that goes stale after a checkout.
    const branch = info?.status?.branch ?? info?.worktree?.branch ?? null

    let worktree = entry.worktrees.find((w) => w.path === path)
    if (!worktree) {
      worktree = { path, branch, projects: [] }
      entry.worktrees.push(worktree)
    }
    worktree.projects.push(project)
  }

  return [...byRepo.values()].sort((a, b) => {
    if (a.key === LOOSE) return 1
    if (b.key === LOOSE) return -1
    return a.name.localeCompare(b.name)
  })
}
