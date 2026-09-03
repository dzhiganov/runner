import { randomUUID } from 'node:crypto'
import type {
  AutoRestartConfig,
  ConfigValidationIssue,
  ProjectConfig,
  ReadinessConfig,
  RunnerConfig
} from '../shared/types.js'
import { findCycles } from '../shared/graph.js'

function readReadiness(
  raw: unknown,
  at: string,
  issues: ConfigValidationIssue[]
): ReadinessConfig | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: at, message: '`readiness` must be an object.' })
    return undefined
  }
  const r = raw as Record<string, unknown>
  const readiness: ReadinessConfig = {}

  if (r.logPattern !== undefined && r.logPattern !== null) {
    if (typeof r.logPattern !== 'string') {
      issues.push({ path: `${at}.logPattern`, message: '`logPattern` must be a string.' })
    } else if (r.logPattern.trim()) {
      try {
        new RegExp(r.logPattern)
        readiness.logPattern = r.logPattern
      } catch (error) {
        issues.push({
          path: `${at}.logPattern`,
          message: `Not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
  }

  if (r.port !== undefined && r.port !== null) {
    const port = r.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      issues.push({ path: `${at}.port`, message: 'Ports must be integers between 1 and 65535.' })
    } else {
      readiness.port = port
    }
  }

  if (r.timeoutMs !== undefined && r.timeoutMs !== null) {
    const timeout = r.timeoutMs
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 1_000) {
      issues.push({ path: `${at}.timeoutMs`, message: '`timeoutMs` must be at least 1000.' })
    } else {
      readiness.timeoutMs = Math.round(timeout)
    }
  }

  return Object.keys(readiness).length ? readiness : undefined
}

/**
 * Parses `autoRestart`. A bare `true` is accepted as shorthand for "on with
 * the defaults", which is what a hand-written config tends to say.
 */
function readAutoRestart(
  raw: unknown,
  at: string,
  issues: ConfigValidationIssue[]
): AutoRestartConfig | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'boolean') return raw ? { enabled: true } : undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: at, message: '`autoRestart` must be an object or true/false.' })
    return undefined
  }

  const r = raw as Record<string, unknown>
  if (r.enabled !== undefined && r.enabled !== null && typeof r.enabled !== 'boolean') {
    issues.push({ path: `${at}.enabled`, message: '`enabled` must be true or false.' })
    return undefined
  }
  const config: AutoRestartConfig = { enabled: r.enabled === true }

  if (r.maxAttempts !== undefined && r.maxAttempts !== null) {
    const value = r.maxAttempts
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
      issues.push({ path: `${at}.maxAttempts`, message: '`maxAttempts` must be between 1 and 100.' })
    } else {
      config.maxAttempts = value
    }
  }

  if (r.delayMs !== undefined && r.delayMs !== null) {
    const value = r.delayMs
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 100) {
      issues.push({ path: `${at}.delayMs`, message: '`delayMs` must be at least 100.' })
    } else {
      config.delayMs = Math.round(value)
    }
  }

  return config.enabled || config.maxAttempts || config.delayMs ? config : undefined
}

/**
 * Rewrites projects saved by a version of Runner that knew about Docker.
 *
 * Docker projects derived their command from a `docker` block rather than
 * storing one, so dropping the split would leave them with nothing to run and
 * fail validation — which, on load, reads as "your config is gone". Turning
 * each one into the command it was already running keeps the project working
 * and makes the command visible and editable, which it never was before.
 */
export function migrate(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const projects = (raw as Record<string, unknown>).projects
  if (!Array.isArray(projects)) return raw

  return {
    ...(raw as Record<string, unknown>),
    projects: projects.map((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
      const { kind, docker, ...rest } = entry as Record<string, unknown>
      if (kind !== 'docker') return rest
      const runCommand =
        typeof rest.runCommand === 'string' && rest.runCommand.trim()
          ? rest.runCommand
          : composeCommand(docker)
      return { ...rest, runCommand }
    })
  }
}

/** The command an old Docker project was effectively running, as plain text. */
function composeCommand(docker: unknown): string {
  const d = (typeof docker === 'object' && docker !== null ? docker : {}) as Record<string, unknown>
  if (d.mode === 'container' && typeof d.container === 'string' && d.container.trim()) {
    const name = d.container.trim()
    return `docker start '${name}' && docker logs -f --tail 200 '${name}'`
  }
  const parts = ['docker compose']
  if (typeof d.file === 'string' && d.file.trim()) parts.push(`-f '${d.file.trim()}'`)
  if (typeof d.projectName === 'string' && d.projectName.trim()) {
    parts.push(`-p '${d.projectName.trim()}'`)
  }
  parts.push('up')
  if (d.build === true) parts.push('--build')
  if (Array.isArray(d.services)) {
    for (const service of d.services) {
      if (typeof service === 'string' && service.trim()) parts.push(`'${service.trim()}'`)
    }
  }
  return parts.join(' ')
}

/**
 * Parses `scanRoots`, the folders discovery walks looking for projects.
 *
 * Paths are kept exactly as written rather than expanded: a config that says
 * `~/Projects` should still mean the right thing on another machine, and the
 * raw-JSON editor should show back what was typed.
 */
function readScanRoots(
  raw: unknown,
  issues: ConfigValidationIssue[]
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    issues.push({ path: 'scanRoots', message: '`scanRoots` must be an array of folder paths.' })
    return undefined
  }
  const roots: string[] = []
  raw.forEach((value, i) => {
    if (typeof value !== 'string' || !value.trim()) {
      issues.push({ path: `scanRoots[${i}]`, message: 'Scan roots must be non-empty paths.' })
      return
    }
    const path = value.trim()
    if (!roots.includes(path)) roots.push(path)
  })
  return roots
}

export function validateConfig(
  raw: unknown
): { ok: true; config: RunnerConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const issues: ConfigValidationIssue[] = []

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: '', message: 'Config must be a JSON object.' }] }
  }
  const projectsRaw = (raw as Record<string, unknown>).projects
  if (!Array.isArray(projectsRaw)) {
    return { ok: false, issues: [{ path: 'projects', message: '`projects` must be an array.' }] }
  }

  const scanRoots = readScanRoots((raw as Record<string, unknown>).scanRoots, issues)

  const seenNames = new Set<string>()
  const seenIds = new Set<string>()
  const projects: ProjectConfig[] = []
  /** Raw `dependsOn` per project index, checked once every id is known. */
  const pendingDeps: { index: number; ids: string[] }[] = []

  projectsRaw.forEach((entry, index) => {
    const at = `projects[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push({ path: at, message: 'Each project must be an object.' })
      return
    }
    const p = entry as Record<string, unknown>

    const name = typeof p.name === 'string' ? p.name.trim() : ''
    if (!name) issues.push({ path: `${at}.name`, message: '`name` is required.' })
    else if (seenNames.has(name)) issues.push({ path: `${at}.name`, message: `Duplicate name "${name}".` })
    seenNames.add(name)

    const path = typeof p.path === 'string' ? p.path.trim() : ''
    if (!path) issues.push({ path: `${at}.path`, message: '`path` is required.' })

    const runCommand = typeof p.runCommand === 'string' ? p.runCommand.trim() : ''
    if (!runCommand) {
      issues.push({ path: `${at}.runCommand`, message: '`runCommand` is required.' })
    }

    let port: number[] | undefined
    if (p.port !== undefined && p.port !== null) {
      const list = Array.isArray(p.port) ? p.port : [p.port]
      const nums: number[] = []
      list.forEach((value, i) => {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
          issues.push({ path: `${at}.port[${i}]`, message: 'Ports must be integers between 1 and 65535.' })
          return
        }
        if (!nums.includes(value)) nums.push(value)
      })
      port = nums
    }

    if (p.dependsOn !== undefined && p.dependsOn !== null) {
      if (!Array.isArray(p.dependsOn)) {
        issues.push({ path: `${at}.dependsOn`, message: '`dependsOn` must be an array of project ids.' })
      } else {
        const ids: string[] = []
        p.dependsOn.forEach((value, i) => {
          if (typeof value !== 'string' || !value.trim()) {
            issues.push({ path: `${at}.dependsOn[${i}]`, message: 'Dependencies must be project ids.' })
            return
          }
          if (!ids.includes(value.trim())) ids.push(value.trim())
        })
        pendingDeps.push({ index: projects.length, ids })
      }
    }

    const readiness = readReadiness(p.readiness, `${at}.readiness`, issues)
    const autoRestart = readAutoRestart(p.autoRestart, `${at}.autoRestart`, issues)

    let autoOpen = false
    if (p.autoOpen !== undefined && p.autoOpen !== null) {
      if (typeof p.autoOpen !== 'boolean') {
        issues.push({ path: `${at}.autoOpen`, message: '`autoOpen` must be true or false.' })
      } else {
        autoOpen = p.autoOpen
      }
    }

    let env: Record<string, string> | undefined
    if (p.env !== undefined && p.env !== null) {
      if (typeof p.env !== 'object' || Array.isArray(p.env)) {
        issues.push({ path: `${at}.env`, message: '`env` must be an object of string values.' })
      } else {
        env = {}
        for (const [key, value] of Object.entries(p.env as Record<string, unknown>)) {
          if (typeof value !== 'string') {
            issues.push({ path: `${at}.env.${key}`, message: 'Env values must be strings.' })
            continue
          }
          env[key] = value
        }
      }
    }

    let protocol: 'http' | 'https' | undefined
    if (p.protocol !== undefined && p.protocol !== null) {
      if (p.protocol !== 'http' && p.protocol !== 'https') {
        issues.push({ path: `${at}.protocol`, message: "`protocol` must be \"http\" or \"https\"." })
      } else {
        protocol = p.protocol
      }
    }

    for (const key of ['shell', 'cwd'] as const) {
      if (p[key] !== undefined && p[key] !== null && typeof p[key] !== 'string') {
        issues.push({ path: `${at}.${key}`, message: `\`${key}\` must be a string.` })
      }
    }

    let id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : randomUUID()
    if (seenIds.has(id)) id = randomUUID()
    seenIds.add(id)

    projects.push({
      id,
      name,
      path,
      ...(runCommand ? { runCommand } : {}),
      ...(port && port.length ? { port } : {}),
      ...(readiness ? { readiness } : {}),
      ...(autoOpen ? { autoOpen } : {}),
      ...(autoRestart ? { autoRestart } : {}),
      ...(protocol ? { protocol } : {}),
      ...(env && Object.keys(env).length ? { env } : {}),
      ...(typeof p.shell === 'string' && p.shell.trim() ? { shell: p.shell.trim() } : {}),
      ...(typeof p.cwd === 'string' && p.cwd.trim() ? { cwd: p.cwd.trim() } : {})
    })
  })

  // Dependencies are resolved last: an id is only meaningful once every project
  // has been read, and ids are reassigned above when they clash.
  const known = new Set(projects.map((project) => project.id))
  const nameOf = (id: string): string => projects.find((p) => p.id === id)?.name ?? id

  for (const { index, ids } of pendingDeps) {
    const project = projects[index]
    if (!project) continue
    const at = `projects[${index}].dependsOn`
    const resolved: string[] = []
    ids.forEach((id, i) => {
      if (id === project.id) {
        issues.push({ path: `${at}[${i}]`, message: 'A project cannot depend on itself.' })
        return
      }
      if (!known.has(id)) {
        issues.push({ path: `${at}[${i}]`, message: `No project with id "${id}".` })
        return
      }
      resolved.push(id)
    })
    if (resolved.length) project.dependsOn = resolved
  }

  for (const cycle of findCycles(projects)) {
    issues.push({
      path: 'projects',
      message: `Dependency cycle: ${cycle.map(nameOf).join(' → ')}.`
    })
  }

  if (issues.length) return { ok: false, issues }
  return { ok: true, config: { projects, ...(scanRoots?.length ? { scanRoots } : {}) } }
}
