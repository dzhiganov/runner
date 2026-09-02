import type { ProjectConfig } from './types.js'

/**
 * Dependency-graph helpers, shared by the config validator, the start
 * orchestrator and the sidebar tree so all three agree on what depends on what.
 *
 * Edges point from a project to the projects it needs: `dependsOn` is read as
 * "start these first".
 */

export function byId(projects: ProjectConfig[]): Map<string, ProjectConfig> {
  return new Map(projects.map((project) => [project.id, project]))
}

/** Dependencies of `id` that actually exist, de-duplicated, in config order. */
export function dependenciesOf(project: ProjectConfig, known: Set<string>): string[] {
  const out: string[] = []
  for (const id of project.dependsOn ?? []) {
    if (id === project.id || !known.has(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/**
 * Every cycle reachable in the graph, each as the list of ids that close it.
 *
 * Reported rather than merely detected because "A → B → A" is the only message
 * that tells the user which edge to delete.
 */
export function findCycles(projects: ProjectConfig[]): string[][] {
  const known = new Set(projects.map((p) => p.id))
  const map = byId(projects)
  const cycles: string[][] = []
  const seen = new Set<string>()
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (id: string): void => {
    const mark = state.get(id)
    if (mark === 'done') return
    if (mark === 'visiting') {
      const start = stack.indexOf(id)
      const cycle = stack.slice(start)
      // The same cycle is reachable from every node on it; keep one copy,
      // keyed on its rotation-independent member set.
      const key = [...cycle].sort().join('>')
      if (!seen.has(key)) {
        seen.add(key)
        cycles.push([...cycle, id])
      }
      return
    }

    const project = map.get(id)
    if (!project) return
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of dependenciesOf(project, known)) visit(dep)
    stack.pop()
    state.set(id, 'done')
  }

  for (const project of projects) visit(project.id)
  return cycles
}

/**
 * `id` and everything it transitively needs, dependencies first.
 *
 * Safe on a cyclic graph — a node already on the stack is skipped — so the UI
 * keeps working while the user is midway through editing a bad config.
 */
export function startOrder(projects: ProjectConfig[], id: string): ProjectConfig[] {
  const known = new Set(projects.map((p) => p.id))
  const map = byId(projects)
  const ordered: ProjectConfig[] = []
  const done = new Set<string>()
  const onStack = new Set<string>()

  const visit = (current: string): void => {
    if (done.has(current) || onStack.has(current)) return
    const project = map.get(current)
    if (!project) return
    onStack.add(current)
    for (const dep of dependenciesOf(project, known)) visit(dep)
    onStack.delete(current)
    done.add(current)
    ordered.push(project)
  }

  visit(id)
  return ordered
}

/** Ids of the projects that list `id` as a dependency, directly. */
export function dependentsOf(projects: ProjectConfig[], id: string): string[] {
  return projects.filter((p) => (p.dependsOn ?? []).includes(id)).map((p) => p.id)
}

export interface TreeNode {
  project: ProjectConfig
  /** Ancestor chain plus this project's id — unique per position in the tree. */
  key: string
  depth: number
  children: TreeNode[]
}

/**
 * The sidebar's folder-and-files view: top level is every project nothing
 * depends on, nested under each is what it needs.
 *
 * A shared dependency appears under each of its dependents, which is what makes
 * the relationship readable; `key` keeps those copies individually addressable.
 * A pure cycle has no root, so its members are surfaced at the top level rather
 * than vanishing from the sidebar.
 */
export function buildTree(projects: ProjectConfig[]): TreeNode[] {
  const known = new Set(projects.map((p) => p.id))
  const map = byId(projects)
  const isDependency = new Set<string>()
  for (const project of projects) {
    for (const dep of dependenciesOf(project, known)) isDependency.add(dep)
  }

  const build = (project: ProjectConfig, ancestors: string[]): TreeNode => {
    const chain = [...ancestors, project.id]
    const children: TreeNode[] = []
    for (const dep of dependenciesOf(project, known)) {
      // Stopping at an ancestor keeps a cyclic config from recursing forever.
      if (ancestors.includes(dep)) continue
      const child = map.get(dep)
      if (child) children.push(build(child, chain))
    }
    return { project, key: chain.join('/'), depth: ancestors.length, children }
  }

  const roots = projects.filter((p) => !isDependency.has(p.id))
  const nodes = roots.map((project) => build(project, []))

  // Members of a cycle are everyone's dependency and therefore nobody's root.
  // Without this they would disappear from the sidebar entirely, which is the
  // worst possible way to learn a config has a loop in it.
  const rendered = new Set<string>()
  const collect = (node: TreeNode): void => {
    rendered.add(node.project.id)
    node.children.forEach(collect)
  }
  nodes.forEach(collect)

  for (const project of projects) {
    if (!rendered.has(project.id)) {
      const node = build(project, [])
      collect(node)
      nodes.push(node)
    }
  }

  return nodes
}
