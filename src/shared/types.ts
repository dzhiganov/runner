/**
 * How Runner decides a project is up. Only matters for projects other projects
 * depend on — a dependent is not started until its dependencies are ready.
 */
export interface ReadinessConfig {
  /** Regular expression tested against the project's output. */
  logPattern?: string
  /** Wait until this TCP port accepts a connection. Defaults to the running port. */
  port?: number
  /** Give up waiting after this long. Defaults to 90s. */
  timeoutMs?: number
}

/**
 * Bringing a crashed project back by itself.
 *
 * Only unexpected exits count: a stop the user asked for, or a clean exit, is
 * taken at face value. Attempts are consecutive — a run that stays up resets
 * the count — so a project that crashes once a day is retried every time,
 * while one that cannot start at all is given up on quickly.
 */
export interface AutoRestartConfig {
  enabled: boolean
  /** Consecutive retries before Runner gives up. Defaults to 3. */
  maxAttempts?: number
  /** Wait before the first retry, doubled for each one after. Defaults to 1s. */
  delayMs?: number
}

/** Shape of a single project entry in the JSON config. */
export interface ProjectConfig {
  /** Stable identifier. Generated when a project is created; never shown to the user. */
  id: string
  name: string
  /** Absolute or `~`-prefixed path to the project directory. */
  path: string
  /** Command handed to the shell, e.g. `npm run dev`. */
  runCommand?: string
  /**
   * Ports this project may use, tried in order. The first free one wins and is
   * exported as PORT. The list is authoritative: if every entry is taken the
   * project cannot start, and Runner says so instead of inventing a port.
   * Omit or leave empty to not manage ports at all.
   */
  port?: number[]
  /**
   * Ids of projects that must be up before this one starts. Runner starts the
   * whole tree, deepest first, and refuses configurations that contain a cycle.
   */
  dependsOn?: string[]
  /** How dependents know this project has finished starting. */
  readiness?: ReadinessConfig
  /** Open the project in the browser once it answers. Defaults to off. */
  autoOpen?: boolean
  /** Bring the project back up after it crashes. Defaults to off. */
  autoRestart?: AutoRestartConfig
  /** Scheme used when opening the project in a browser. Defaults to http. */
  protocol?: 'http' | 'https'
  /** Extra environment variables merged on top of the inherited environment. */
  env?: Record<string, string>
  /** Shell used to run `runCommand`. Defaults to the user's login shell. */
  shell?: string
  /** Working directory override. Defaults to `path`. */
  cwd?: string
}

export interface RunnerConfig {
  projects: ProjectConfig[]
}

export type ProjectStatus =
  | 'stopped'
  | 'waiting'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'exited'
  | 'error'

/** Live, non-persisted state of a project's process. */
export interface ProjectRuntime {
  id: string
  status: ProjectStatus
  /** Port the child was told to use via PORT, once resolved. Null when unmanaged. */
  port: number | null
  /**
   * Ports scraped from the child's own output (`http://localhost:4200/` and
   * friends), in order of first appearance. This is the only reliable answer
   * for commands that start several servers at once, or that ignore PORT.
   */
  detectedPorts: number[]
  /**
   * True when every port in the project's list is already taken, so starting it
   * would fail. Kept fresh while the project is stopped so the UI can disable
   * Run before the user clicks it.
   */
  portsBusy: boolean
  pid: number | null
  /** Non-null once the process has exited. */
  exitCode: number | null
  /** Populated when status is 'error' or a non-zero exit. */
  message: string | null
  startedAt: number | null
  /** Id of the dependency currently being waited on, while status is `waiting`. */
  waitingFor: string | null
  /**
   * Consecutive automatic restarts since the project last ran steadily. Zero
   * when auto-restart is off or the project is behaving; shown in the UI so a
   * crash loop is visible rather than merely noisy.
   */
  restartAttempts: number
}

export interface ConfigValidationIssue {
  path: string
  message: string
}

export type SaveConfigResult =
  | { ok: true; config: RunnerConfig }
  | { ok: false; issues: ConfigValidationIssue[] }
