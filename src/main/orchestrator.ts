import type { ProjectConfig, ProjectStatus } from '../shared/types.js'
import { dependentsOf, startOrder } from '../shared/graph.js'
import { ProcessManager } from './process-manager.js'
import { waitForPort } from './ports.js'

/** How long a dependency gets to come up before Runner stops waiting on it. */
const DEFAULT_READY_TIMEOUT_MS = 90_000
/** A project with nothing to probe is given this long to fall over on its own. */
const SETTLE_MS = 600

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g
const FAILED: ProjectStatus[] = ['error', 'exited']

type ReadyOutcome = 'ready' | 'failed' | 'timeout' | 'cancelled'

/** Why a dependency was not waited on any further, phrased for the terminal. */
const OUTCOME_NOTE: Record<Exclude<ReadyOutcome, 'ready'>, string> = {
  failed: 'failed to start',
  timeout: 'did not report ready in time',
  cancelled: 'was cancelled'
}

export interface TreeStartResult {
  ok: boolean
  /** Projects that were started, in the order they came up. */
  started: string[]
  message: string | null
}

/**
 * Starts and stops whole dependency trees.
 *
 * The rule is "deepest first, and wait": a project is not started until every
 * project it depends on is not merely spawned but actually answering, because a
 * frontend that boots while its backend is still binding a port fails in ways
 * that look nothing like the real problem.
 */
export class Orchestrator {
  /** In-flight tree starts, so a double click does not start a project twice. */
  private pending = new Map<string, Promise<TreeStartResult>>()
  private cancels = new Map<string, AbortController>()

  constructor(
    private manager: ProcessManager,
    private projects: () => ProjectConfig[]
  ) {}

  private find(id: string): ProjectConfig | undefined {
    return this.projects().find((p) => p.id === id)
  }

  /** True while a tree start involving `id` is still working through its dependencies. */
  isStarting(id: string): boolean {
    return this.pending.has(id)
  }

  /**
   * Brings up `id` and everything it depends on.
   *
   * Concurrent calls for the same project share one run; concurrent calls for
   * different projects that happen to share a dependency each see it as already
   * running and simply wait for it.
   */
  startTree(id: string): Promise<TreeStartResult> {
    const existing = this.pending.get(id)
    if (existing) return existing

    const controller = new AbortController()
    this.cancels.set(id, controller)
    const run = this.runTree(id, controller.signal).finally(() => {
      this.pending.delete(id)
      this.cancels.delete(id)
    })
    this.pending.set(id, run)
    return run
  }

  /** Abandons a tree start in progress. The projects already up are left alone. */
  cancel(id: string): void {
    this.cancels.get(id)?.abort()
    // A project waiting on a dependency has no process of its own to stop, so
    // clear the waiting state here or it would sit there for good. Scoped to
    // this tree: another tree starting at the same time keeps its own queue.
    for (const project of startOrder(this.projects(), id)) {
      const runtime = this.manager.runtime(project.id)
      if (runtime.status === 'waiting' && !this.manager.isRunning(project.id)) {
        this.manager.patch(project.id, { status: 'stopped', waitingFor: null, startedAt: null })
      }
    }
  }

  private async runTree(id: string, signal: AbortSignal): Promise<TreeStartResult> {
    const all = this.projects()
    const order = startOrder(all, id)
    const target = this.find(id)
    if (!target) return { ok: false, started: [], message: 'Project not found.' }

    const dependencies = order.filter((p) => p.id !== id)
    if (dependencies.length) {
      this.manager.write(
        id,
        `\x1b[90m› starting ${dependencies.length} ${dependencies.length === 1 ? 'dependency' : 'dependencies'} first: ${dependencies
          .map((p) => p.name)
          .join(' → ')}\x1b[0m\r\n`
      )
    }

    // Everything queued behind a dependency is marked up front, so the sidebar
    // shows the whole tree working rather than one project at a time.
    for (const project of order) {
      if (project.id === id && !dependencies.length) continue
      if (this.manager.isRunning(project.id)) continue
      this.manager.patch(project.id, {
        status: 'waiting',
        waitingFor: dependencies[0]?.id ?? null,
        message: null,
        startedAt: Date.now()
      })
    }

    const started: string[] = []

    for (const project of order) {
      if (signal.aborted) {
        this.clearWaiting(order, id)
        return { ok: false, started, message: 'Start cancelled.' }
      }

      const isTarget = project.id === id
      for (const queued of order) {
        if (queued.id === project.id) continue
        if (this.manager.runtime(queued.id).status === 'waiting') {
          this.manager.patch(queued.id, { waitingFor: project.id })
        }
      }

      const alreadyUp = this.manager.isRunning(project.id)
      if (!alreadyUp) {
        await this.manager.start(project)
      } else if (!isTarget) {
        this.manager.write(id, `\x1b[90m› ${project.name} is already running\x1b[0m\r\n`)
      }

      const runtime = this.manager.runtime(project.id)
      if (FAILED.includes(runtime.status)) {
        const message = `${project.name} failed to start${runtime.message ? `: ${runtime.message}` : ''}`
        this.fail(order, id, project.id, message)
        return { ok: false, started, message }
      }
      if (!alreadyUp) started.push(project.id)

      // The target itself has nobody waiting on it, so there is nothing to gain
      // from blocking on its readiness probe.
      if (isTarget) break

      const outcome = await this.awaitReady(project, signal)
      if (outcome === 'ready') {
        this.manager.write(id, `\x1b[90m› ${project.name} is ready\x1b[0m\r\n`)
        continue
      }
      if (outcome === 'cancelled') {
        this.clearWaiting(order, id)
        return { ok: false, started, message: 'Start cancelled.' }
      }
      if (outcome === 'failed') {
        const message = `${project.name} ${OUTCOME_NOTE.failed}${
          this.manager.runtime(project.id).message ? `: ${this.manager.runtime(project.id).message}` : ''
        }`
        this.fail(order, id, project.id, message)
        return { ok: false, started, message }
      }
      // A timeout is not fatal: the dependency is up, we simply could not prove
      // it is serving. Starting the dependent anyway beats refusing to run.
      this.manager.write(
        id,
        `\x1b[33m› ${project.name} ${OUTCOME_NOTE.timeout} — starting ${target.name} anyway\x1b[0m\r\n`
      )
    }

    this.clearWaiting(order, id)
    return { ok: true, started, message: null }
  }

  /** Puts every still-queued project back to rest after an abandoned tree start. */
  private clearWaiting(order: ProjectConfig[], _targetId: string): void {
    for (const project of order) {
      const runtime = this.manager.runtime(project.id)
      if (runtime.status === 'waiting') {
        this.manager.patch(project.id, { status: 'stopped', waitingFor: null, startedAt: null })
      } else if (runtime.waitingFor) {
        this.manager.patch(project.id, { waitingFor: null })
      }
    }
  }

  private fail(order: ProjectConfig[], targetId: string, culpritId: string, message: string): void {
    for (const project of order) {
      if (project.id === culpritId) continue
      const runtime = this.manager.runtime(project.id)
      if (runtime.status !== 'waiting') continue
      this.manager.patch(project.id, {
        status: 'error',
        waitingFor: null,
        startedAt: null,
        message
      })
    }
    this.manager.write(targetId, `\r\n\x1b[31m${message}\x1b[0m\r\n`)
  }

  /**
   * Waits until `project` is genuinely serving, using the most specific signal
   * available: an explicit log pattern, then an explicit port, then whatever
   * the project turned out to be listening on, and finally — with nothing to
   * probe — simply that it survived the first moment of its life.
   */
  private async awaitReady(project: ProjectConfig, signal: AbortSignal): Promise<ReadyOutcome> {
    const timeoutMs = project.readiness?.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    const local = new AbortController()
    const onAbort = (): void => local.abort()
    signal.addEventListener('abort', onAbort, { once: true })

    const stop = (): void => {
      signal.removeEventListener('abort', onAbort)
      local.abort()
    }

    try {
      const outcome = await Promise.race<ReadyOutcome>([
        this.watchFailure(project.id, local.signal),
        this.probe(project, local.signal, timeoutMs),
        new Promise<ReadyOutcome>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), timeoutMs)
          local.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
        })
      ])
      if (signal.aborted) return 'cancelled'
      return outcome
    } finally {
      stop()
    }
  }

  /** Resolves 'failed' the moment the project stops being alive. */
  private watchFailure(id: string, signal: AbortSignal): Promise<ReadyOutcome> {
    return new Promise((resolve) => {
      const done = (outcome: ReadyOutcome): void => {
        this.manager.off('runtime', listener)
        resolve(outcome)
      }
      const listener = (runtime: { id: string; status: ProjectStatus }): void => {
        if (runtime.id !== id) return
        if (FAILED.includes(runtime.status) || runtime.status === 'stopped') done('failed')
      }
      signal.addEventListener('abort', () => done('cancelled'), { once: true })
      this.manager.on('runtime', listener)

      const current = this.manager.runtime(id)
      if (FAILED.includes(current.status)) done('failed')
    })
  }

  private async probe(
    project: ProjectConfig,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<ReadyOutcome> {
    const pattern = project.readiness?.logPattern
    if (pattern) {
      const found = await this.waitForLog(project.id, new RegExp(pattern), signal, timeoutMs)
      return found ? 'ready' : 'timeout'
    }

    const explicit = project.readiness?.port
    if (explicit) {
      return (await waitForPort(explicit, timeoutMs, signal)) ? 'ready' : 'timeout'
    }

    const assigned = this.manager.runtime(project.id).port
    if (assigned !== null) {
      return (await waitForPort(assigned, timeoutMs, signal)) ? 'ready' : 'timeout'
    }

    // Nothing to probe. Give the command a moment to fail outright — the
    // failure watcher wins that race — and otherwise take it at its word.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    return signal.aborted ? 'cancelled' : 'ready'
  }

  private waitForLog(
    id: string,
    pattern: RegExp,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      // The pattern may already have gone past before we subscribed — a fast
      // dependency can print "listening" before the first await comes back.
      let text = this.manager.buffer(id).replace(ANSI_RE, '')
      const finish = (found: boolean): void => {
        this.manager.off('data', listener)
        clearTimeout(timer)
        resolve(found)
      }
      const listener = (projectId: string, chunk: string): void => {
        if (projectId !== id) return
        text += chunk.replace(ANSI_RE, '')
        // Only the tail can complete a match, and an unbounded string here
        // would grow with the whole log.
        if (text.length > 64_000) text = text.slice(-32_000)
        if (pattern.test(text)) finish(true)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      signal.addEventListener('abort', () => finish(false), { once: true })

      if (pattern.test(text)) return finish(true)
      this.manager.on('data', listener)
    })
  }

  /**
   * Stops `id` and the dependencies it pulled up, leaving alone anything a
   * different live project still needs. Dependents come down before the
   * services they talk to, so nothing spends its last seconds erroring.
   */
  async stopTree(id: string): Promise<string[]> {
    this.cancel(id)
    const all = this.projects()
    const order = startOrder(all, id)
    const stopped: string[] = []
    /**
     * What has actually been stopped so far. Reverse topological order means a
     * project's dependents are all decided before it comes up, so this — rather
     * than the tree's membership — is what says whether anyone still needs it.
     * A dependency kept alive for an outside project keeps its own
     * dependencies alive too.
     */
    const settled = new Set<string>()

    for (const project of [...order].reverse()) {
      if (project.id !== id) {
        // Something still running is using it, so it is not ours to stop.
        const stillNeeded = dependentsOf(all, project.id).some(
          (dependentId) =>
            !settled.has(dependentId) &&
            (this.manager.isRunning(dependentId) || this.isStarting(dependentId))
        )
        if (stillNeeded) {
          this.manager.write(
            id,
            `\x1b[90m› leaving ${project.name} up — another project depends on it\x1b[0m\r\n`
          )
          continue
        }
      }

      const live = this.manager.isRunning(project.id)
      // Nothing to stop, but it is not being kept alive either, so anything
      // below it in the tree is free to go.
      settled.add(project.id)
      if (!live) continue

      this.manager.stop(project.id, project)
      stopped.push(project.id)
    }

    return stopped
  }
}
