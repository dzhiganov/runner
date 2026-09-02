import { EventEmitter } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { platform } from 'node:process'
import * as pty from 'node-pty'
import type { ProjectConfig, ProjectRuntime } from '../shared/types.js'
import { expandPath } from './paths.js'
import { anyPortFree, isPortServing, resolvePort, waitForPortsFree } from './ports.js'

/** Scrollback retained per project so the terminal survives a tab switch. */
const MAX_BUFFER_CHARS = 400_000
/** Grace period between SIGTERM and SIGKILL when stopping a project. */
const KILL_GRACE_MS = 4_000
/** Upper bound on ports remembered per project, so noisy output cannot grow forever. */
const MAX_DETECTED_PORTS = 12
/** Tail of output kept between chunks so a URL split across a read still matches. */
const CARRY_CHARS = 160
/**
 * How long a restart waits for the project's own ports to come back before
 * starting anyway. Generous: a stubborn dev server can sit on its socket for a
 * second or two after its parent shell is gone.
 */
const PORT_RELEASE_MS = 8_000
/** How long auto-open waits for the project to actually answer before giving up. */
const AUTO_OPEN_TIMEOUT_MS = 90_000
const AUTO_OPEN_POLL_MS = 300
/** Default retry budget and first delay for auto-restart. */
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RESTART_DELAY_MS = 1_000
/** Longest an auto-restart backoff is allowed to grow to. */
const MAX_RESTART_DELAY_MS = 30_000
/**
 * A run this long counts as healthy, so the next crash starts a fresh retry
 * budget. Without it a project that crashes once a week would eventually
 * exhaust its attempts and stop coming back.
 */
const STABLE_RUN_MS = 20_000

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g
const URL_PORT_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/gi

interface Session {
  proc: pty.IPty
  /** The config the project was started with, so Stop can undo exactly that. */
  project: ProjectConfig
  /** Set while a deliberate stop is in flight, so the exit is not reported as a crash. */
  stopping: boolean
  killTimer: NodeJS.Timeout | null
  /** When this particular run began, for the auto-restart stability check. */
  startedAt: number
}

export interface ProcessManagerEvents {
  data: [projectId: string, chunk: string]
  runtime: [runtime: ProjectRuntime]
  /** A project asked for its URL to be opened. The main process owns the shell. */
  open: [projectId: string, url: string]
}

export function defaultShell(): string {
  if (platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
  // The passwd database is consulted before $SHELL deliberately. launchd does
  // not set SHELL for apps opened from Finder or the Dock, and anything that
  // does launch us with one — `open` from a script, another app — passes on
  // its own shell rather than the user's. Picking the wrong one runs commands
  // with a different PATH, and possibly a different node, than the terminal
  // the user tested them in.
  try {
    const shell = userInfo().shell
    if (shell) return shell
  } catch {
    // userInfo throws if the passwd entry cannot be read.
  }
  return process.env.SHELL || '/bin/zsh'
}

/** The URL Runner would open for a project running on `port`. */
export function urlFor(project: ProjectConfig, port: number): string {
  return `${project.protocol ?? 'http'}://localhost:${port}`
}

/**
 * Owns every child process. The renderer never touches PTYs directly; it sends
 * intents (start/stop/restart) and receives runtime snapshots plus output.
 */
export class ProcessManager extends EventEmitter<ProcessManagerEvents> {
  private sessions = new Map<string, Session>()
  private runtimes = new Map<string, ProjectRuntime>()
  private buffers = new Map<string, string>()
  /** Ports seen in each project's output, and the unscanned tail of that output. */
  private detected = new Map<string, number[]>()
  private carry = new Map<string, string>()
  /** Pending auto-restarts, so a manual start or stop can call them off. */
  private restartTimers = new Map<string, NodeJS.Timeout>()

  runtime(id: string): ProjectRuntime {
    const existing = this.runtimes.get(id)
    if (existing) return existing
    const fresh: ProjectRuntime = {
      id,
      status: 'stopped',
      port: null,
      detectedPorts: [],
      portsBusy: false,
      pid: null,
      exitCode: null,
      message: null,
      startedAt: null,
      waitingFor: null,
      restartAttempts: 0
    }
    this.runtimes.set(id, fresh)
    return fresh
  }

  allRuntimes(): ProjectRuntime[] {
    return [...this.runtimes.values()]
  }

  buffer(id: string): string {
    return this.buffers.get(id) ?? ''
  }

  isRunning(id: string): boolean {
    return this.sessions.has(id)
  }

  runningCount(): number {
    return this.sessions.size
  }

  /** Public so the orchestrator can narrate a tree start in the right pane. */
  patch(id: string, changes: Partial<ProjectRuntime>): void {
    const next = { ...this.runtime(id), ...changes, id }
    this.runtimes.set(id, next)
    this.emit('runtime', next)
  }

  private append(id: string, chunk: string): void {
    const combined = (this.buffers.get(id) ?? '') + chunk
    this.buffers.set(
      id,
      combined.length > MAX_BUFFER_CHARS ? combined.slice(combined.length - MAX_BUFFER_CHARS) : combined
    )
    this.emit('data', id, chunk)
  }

  /** Public so the orchestrator can explain what it is waiting for, in the pane. */
  write(id: string, text: string): void {
    this.append(id, text)
  }

  clearBuffer(id: string): void {
    this.buffers.set(id, '')
  }

  /**
   * Picks up `http://localhost:4200/` style URLs the child prints about itself.
   *
   * PORT injection only describes one server, so a command that starts several
   * (an Nx `run-many`, a monorepo dev script) can only be understood by reading
   * what it says. Whatever is found here is what the UI offers to open.
   */
  private scanForPorts(id: string, chunk: string): void {
    const text = (this.carry.get(id) ?? '') + chunk.replace(ANSI_RE, '')
    const found = this.detected.get(id) ?? []
    let changed = false

    for (const match of text.matchAll(URL_PORT_RE)) {
      const port = Number(match[1])
      if (port < 1 || port > 65535) continue
      if (found.includes(port)) continue
      if (found.length >= MAX_DETECTED_PORTS) break
      found.push(port)
      changed = true
    }

    this.detected.set(id, found)
    this.carry.set(id, text.slice(-CARRY_CHARS))
    if (changed) this.patch(id, { detectedPorts: [...found] })
  }

  /** Calls off a pending auto-restart — the user has taken the wheel. */
  private cancelAutoRestart(id: string): void {
    const timer = this.restartTimers.get(id)
    if (!timer) return
    clearTimeout(timer)
    this.restartTimers.delete(id)
  }

  async start(project: ProjectConfig): Promise<void> {
    if (this.sessions.has(project.id)) return
    this.cancelAutoRestart(project.id)
    await this.spawn(project)
  }

  /**
   * The actual spawn. Separate from `start` so an automatic restart can come
   * through without cancelling the retry budget it is spending.
   */
  private async spawn(project: ProjectConfig): Promise<void> {
    if (this.sessions.has(project.id)) return

    this.clearBuffer(project.id)
    this.detected.set(project.id, [])
    this.carry.set(project.id, '')
    this.patch(project.id, {
      status: 'starting',
      exitCode: null,
      message: null,
      port: null,
      detectedPorts: [],
      pid: null,
      waitingFor: null,
      startedAt: Date.now()
    })

    const cwd = expandPath(project.cwd || project.path)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      this.write(project.id, `\r\n\x1b[31mDirectory not found: ${cwd}\x1b[0m\r\n`)
      this.patch(project.id, { status: 'error', message: `Directory not found: ${cwd}`, startedAt: null })
      return
    }

    let port: number | null = null
    if (project.port?.length) {
      port = await resolvePort(project.port)
      if (port === null) {
        const msg = `All ports are in use: ${project.port.join(', ')}`
        this.write(project.id, `\r\n\x1b[31m${msg}\x1b[0m\r\n`)
        this.patch(project.id, {
          status: 'error',
          message: msg,
          portsBusy: true,
          startedAt: null
        })
        return
      }
      if (port !== project.port[0]) {
        this.write(
          project.id,
          `\x1b[33m› port ${project.port[0]} is busy — using ${port}\x1b[0m\r\n`
        )
      }
    }

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    // Electron injects these into its own children; leaking them makes child
    // Node processes think they are running inside Electron.
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    Object.assign(env, project.env ?? {})
    if (port !== null) env.PORT = String(port)
    env.FORCE_COLOR = env.FORCE_COLOR ?? '1'
    env.TERM = 'xterm-256color'

    const runCommand = project.runCommand ?? ''
    if (!runCommand.trim()) {
      const msg = 'Nothing to run: this project has no command.'
      this.write(project.id, `\r\n\x1b[31m${msg}\x1b[0m\r\n`)
      this.patch(project.id, { status: 'error', message: msg, startedAt: null })
      return
    }

    const shell = project.shell?.trim() || defaultShell()
    // A login + interactive shell so nvm/fnm/asdf shims on PATH behave the same
    // way they do when the user runs the command by hand.
    const args = platform === 'win32' ? ['/c', runCommand] : ['-l', '-i', '-c', runCommand]

    const detail = `  in ${cwd}${port !== null ? ` · PORT=${port}` : ''} · ${shell}`
    this.write(project.id, `\x1b[90m$ ${runCommand}\x1b[0m\r\n\x1b[90m${detail}\x1b[0m\r\n\r\n`)

    let proc: pty.IPty
    try {
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.write(project.id, `\r\n\x1b[31mFailed to start: ${msg}\x1b[0m\r\n`)
      this.patch(project.id, { status: 'error', message: msg, startedAt: null })
      return
    }

    const session: Session = {
      proc,
      project,
      stopping: false,
      killTimer: null,
      startedAt: Date.now()
    }
    this.sessions.set(project.id, session)
    this.patch(project.id, {
      status: 'running',
      pid: proc.pid,
      port,
      portsBusy: false
    })

    if (project.autoOpen) void this.autoOpen(project, session)

    proc.onData((chunk) => {
      this.append(project.id, chunk)
      this.scanForPorts(project.id, chunk)
    })

    proc.onExit(({ exitCode, signal }) => {
      if (session.killTimer) clearTimeout(session.killTimer)
      this.sessions.delete(project.id)

      const clean = session.stopping || exitCode === 0
      const detail = session.stopping
        ? 'stopped'
        : signal
          ? `killed by signal ${signal}`
          : `exited with code ${exitCode}`
      this.write(
        project.id,
        `\r\n\x1b[${clean ? 90 : 31}m› ${detail}\x1b[0m\r\n`
      )

      // A run that lasted counts as healthy, whatever ended it, so the next
      // crash gets a full retry budget rather than the tail of an old one.
      const lasted = Date.now() - session.startedAt >= STABLE_RUN_MS
      const attempts = clean || lasted ? 0 : this.runtime(project.id).restartAttempts

      this.patch(project.id, {
        status: clean ? 'stopped' : 'exited',
        exitCode,
        pid: null,
        detectedPorts: [],
        message: clean ? null : detail,
        waitingFor: null,
        startedAt: null,
        restartAttempts: attempts
      })

      if (!clean) this.considerAutoRestart(project, attempts)
    })
  }

  /**
   * Opens the project in the browser once it is genuinely answering.
   *
   * Waiting for the port matters more than it looks: a browser pointed at a
   * dev server two seconds before it binds shows a connection error, and the
   * user is left refreshing a tab wondering whether Runner did anything.
   */
  private async autoOpen(project: ProjectConfig, session: Session): Promise<void> {
    const deadline = Date.now() + AUTO_OPEN_TIMEOUT_MS
    for (;;) {
      // A stop, a restart, or a crash cancels the open — the session object
      // identifies this particular run, so a restart's open does not fire twice.
      if (this.sessions.get(project.id) !== session || session.stopping) return
      if (Date.now() >= deadline) {
        this.write(project.id, `\x1b[33m› nothing to open — no port answered\x1b[0m\r\n`)
        return
      }

      const runtime = this.runtime(project.id)
      const port = runtime.detectedPorts[0] ?? runtime.port
      if (port !== null && (await isPortServing(port))) {
        const url = urlFor(project, port)
        this.write(project.id, `\x1b[90m› opening ${url}\x1b[0m\r\n`)
        this.emit('open', project.id, url)
        return
      }

      await new Promise((resolve) => setTimeout(resolve, AUTO_OPEN_POLL_MS))
    }
  }

  /** Schedules the next automatic restart, or explains why there will not be one. */
  private considerAutoRestart(project: ProjectConfig, previousAttempts: number): void {
    const config = project.autoRestart
    if (!config?.enabled) return

    const max = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const attempt = previousAttempts + 1
    if (attempt > max) {
      this.write(
        project.id,
        `\x1b[31m› auto-restart gave up after ${max} attempt${max === 1 ? '' : 's'}\x1b[0m\r\n`
      )
      this.patch(project.id, { restartAttempts: 0 })
      return
    }

    const base = config.delayMs ?? DEFAULT_RESTART_DELAY_MS
    const delay = Math.min(base * 2 ** (attempt - 1), MAX_RESTART_DELAY_MS)
    this.write(
      project.id,
      `\x1b[33m› auto-restarting in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${max})\x1b[0m\r\n`
    )
    this.patch(project.id, { restartAttempts: attempt })

    const timer = setTimeout(() => {
      this.restartTimers.delete(project.id)
      if (this.sessions.has(project.id)) return
      void this.relaunch(project)
    }, delay)
    this.restartTimers.set(project.id, timer)
  }

  /**
   * SIGTERM the child's process group, escalating to SIGKILL after a grace
   * period.
   */
  stop(id: string, _project?: ProjectConfig): void {
    this.cancelAutoRestart(id)
    this.patch(id, { restartAttempts: 0 })

    const session = this.sessions.get(id)
    if (!session) return
    if (session.stopping) return
    session.stopping = true
    this.patch(id, { status: 'stopping', waitingFor: null })

    this.signalGroup(session.proc.pid, 'SIGTERM')
    session.killTimer = setTimeout(() => {
      if (!this.sessions.has(id)) return
      this.write(id, `\r\n\x1b[33m› did not exit in ${KILL_GRACE_MS / 1000}s — sending SIGKILL\x1b[0m\r\n`)
      this.signalGroup(session.proc.pid, 'SIGKILL')
    }, KILL_GRACE_MS)
  }

  /**
   * Targets the whole process group so `npm run dev` takes its spawned children
   * (vite, tsc --watch, …) down with it instead of orphaning them on the port.
   */
  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {
        // Already gone.
      }
    }
  }

  /** Waits for the exit of the live session for `id`, if there is one. */
  private awaitExit(id: string): Promise<void> {
    return new Promise((resolve) => {
      const session = this.sessions.get(id)
      if (!session) return resolve()
      session.proc.onExit(() => resolve())
    })
  }

  /**
   * Stops the project, waits for it to let go of its ports, then starts it.
   *
   * The wait is the whole point. A dev server holds its listening socket for a
   * moment after the shell Runner spawned it through is gone, so a restart that
   * starts the instant the PTY exits hits its own leftover listener and reports
   * every port as busy — which is why restarting used to take two clicks.
   */
  async restart(project: ProjectConfig): Promise<void> {
    this.cancelAutoRestart(project.id)
    this.patch(project.id, { restartAttempts: 0 })
    await this.relaunch(project)
  }

  /** Restart without touching the retry budget, shared with auto-restart. */
  private async relaunch(project: ProjectConfig): Promise<void> {
    if (this.sessions.has(project.id)) {
      const exited = this.awaitExit(project.id)
      this.stop(project.id, project)
      await exited
    }

    const ports = project.port ?? []
    if (ports.length && !(await anyPortFree(ports))) {
      this.write(project.id, `\x1b[90m› waiting for ${ports.join(', ')} to be released\x1b[0m\r\n`)
      const freed = await waitForPortsFree(ports, PORT_RELEASE_MS)
      if (!freed) {
        this.write(
          project.id,
          `\x1b[33m› ${ports.join(', ')} still busy after ${PORT_RELEASE_MS / 1000}s — starting anyway\x1b[0m\r\n`
        )
      }
    }

    await this.spawn(project)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.proc.resize(Math.max(cols, 8), Math.max(rows, 4))
    } catch {
      // The process can exit between the renderer's measurement and this call.
    }
  }

  /** Forward keystrokes (Ctrl-C, prompts) from the terminal pane to the child. */
  input(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data)
  }

  /**
   * Recomputes, for each stopped project, whether every configured port is
   * taken. Lets the UI disable Run up front instead of failing on click.
   */
  async refreshPortAvailability(projects: ProjectConfig[]): Promise<void> {
    for (const project of projects) {
      const ports = project.port ?? []
      const busy =
        !this.sessions.has(project.id) && ports.length > 0 ? !(await anyPortFree(ports)) : false
      if (this.runtime(project.id).portsBusy !== busy) {
        this.patch(project.id, { portsBusy: busy })
      }
    }
  }

  /** Best-effort teardown of everything, used on app quit. */
  async stopAll(timeoutMs = KILL_GRACE_MS + 1_000): Promise<void> {
    for (const id of [...this.restartTimers.keys()]) this.cancelAutoRestart(id)
    const ids = [...this.sessions.keys()]
    if (!ids.length) return
    await Promise.race([
      Promise.all(
        ids.map((id) => {
          const exited = this.awaitExit(id)
          this.stop(id, this.sessions.get(id)?.project)
          return exited
        })
      ),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ])
    for (const id of [...this.sessions.keys()]) {
      const session = this.sessions.get(id)
      if (session) this.signalGroup(session.proc.pid, 'SIGKILL')
    }
  }

  /** Drop runtime rows for projects that no longer exist in the config. */
  prune(validIds: Set<string>): void {
    for (const id of [...this.runtimes.keys()]) {
      if (!validIds.has(id) && !this.sessions.has(id)) {
        this.cancelAutoRestart(id)
        this.runtimes.delete(id)
        this.buffers.delete(id)
        this.detected.delete(id)
        this.carry.delete(id)
      }
    }
  }
}
