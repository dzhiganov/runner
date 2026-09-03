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
  /**
   * Restart when a source file in the project changes. Off by default.
   * `node_modules`, build output and dotfiles are never watched.
   */
  watch?: boolean
}

/** Desktop notifications for projects becoming ready, failing, or crashing. */
export interface NotificationConfig {
  enabled: boolean
  /** Only interrupt for failures — no "is ready". Defaults to off. */
  failuresOnly?: boolean
}

export interface RunnerConfig {
  projects: ProjectConfig[]
  /**
   * Folders scanned for projects, `~`-prefixed or absolute. Empty or absent
   * means discovery has not been set up; the UI offers likely roots instead.
   */
  scanRoots?: string[]
  /** Desktop notifications. Absent means on, with readiness included. */
  notifications?: NotificationConfig
}

/** Package manager inferred from a project's lockfile. */
export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun'

/**
 * A project directory found by a scan, before the user has decided whether to
 * add it. Not persisted — it is regenerated on every scan.
 */
export interface DiscoveredProject {
  /** From `package.json` `name`, falling back to the directory name. */
  name: string
  /** Absolute path, as found on disk. Identity — compared against config paths. */
  path: string
  /** The same path in `~` form, for display. Identity still lives in `path`. */
  displayPath: string
  hasGit: boolean
  hasPackageJson: boolean
  /** Null when no lockfile identified one. */
  packageManager: PackageManager | null
  /** Every script in `package.json`, spelled for this package manager. */
  commands: string[]
  /**
   * The command Runner would use if added: the first long-running script it
   * recognises. Null when there is nothing sensible to suggest, in which case
   * the user has to supply one.
   */
  suggestedCommand: string | null
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

/** One working copy of a repository — the main one, or a linked worktree. */
export interface Worktree {
  /** Absolute path to the working copy. */
  path: string
  /** Commit currently checked out, or null when it could not be read. */
  head: string | null
  /** Short branch name, or null when the head is detached. */
  branch: string | null
  detached: boolean
  locked: boolean
}

/**
 * Working-copy state of one checkout.
 *
 * Deliberately five facts and no more: Runner answers "what state is this
 * project in", and nothing about changing that state.
 */
export interface GitStatus {
  /** Short branch name, or null when the head is detached. */
  branch: string | null
  detached: boolean
  /**
   * Commits ahead of and behind the upstream. Both null when the branch has no
   * upstream — which is not the same as being level with one, and must not
   * render as zero.
   */
  ahead: number | null
  behind: number | null
  /** Tracked files with changes, staged or not. */
  changed: number
  untracked: number
  clean: boolean
}

/** A repository, and every working copy of it on this machine. */
export interface RepoInfo {
  /** Path of the main working copy. */
  root: string
  /**
   * The shared git directory. This is the repository's identity: two checkouts
   * of one repository have different paths but the same common directory.
   */
  commonDir: string
  /** The repository's name, taken from its main working copy's directory. */
  name: string
  /** Main worktree first, as git lists them. */
  worktrees: Worktree[]
}

/**
 * A listening process Runner did not start, attributed to a project.
 *
 * This is how Runner answers "what is actually running" rather than only
 * "what did I start" — a dev server launched by hand in a terminal shows up
 * on the project it belongs to, instead of leaving that project looking
 * stopped while its port is mysteriously busy.
 */
export interface ExternalProcess {
  pid: number
  /** Full command line where `ps` would give one. */
  command: string
  cwd: string | null
  /** Every port this process is listening on, ascending. */
  ports: number[]
  /** The configured project whose directory contains it. */
  projectId: string
  /** The worktree it is running in, when the project is in a repository. */
  worktreePath: string | null
  /** Branch of that worktree, when it has one. */
  branch: string | null
}

/** A configured project placed in its repository, for the grouped sidebar. */
export interface ProjectGit {
  projectId: string
  /** Null when the project is not in a git repository at all. */
  repo: RepoInfo | null
  /** The worktree this project's directory is, when it is one. */
  worktree: Worktree | null
  /** Working-copy state, read on its own faster cycle than the repository. */
  status: GitStatus | null
}

/** A process found holding a port, as far as the OS would say. */
export interface PortOwner {
  pid: number
  /** Full command line where `ps` would give one, else lsof's short name. */
  command: string
  /** Working directory, or null when it could not be read. */
  cwd: string | null
  /** Process group id, or null when it could not be read. */
  pgid: number | null
}

/**
 * How much Runner knows about whoever holds a contested port, which decides
 * what the conflict dialog is allowed to offer.
 */
export type PortConflictTier =
  /** Runner started it and knows which project it is. */
  | 'runner'
  /** Not Runner's, but its directory matches a configured project. */
  | 'known'
  /** Nothing is known about it. No kill is offered. */
  | 'unknown'

/** Everything the UI needs to explain, and resolve, one port conflict. */
export interface PortConflict {
  /** The project that wanted to start. */
  projectId: string
  port: number
  tier: PortConflictTier
  owner: PortOwner | null
  /** Name of the project this process belongs to, for the 🟢 and 🟡 tiers. */
  ownerProjectName: string | null
  /** Id of the Runner-owned project holding it, so it can be stopped properly. */
  ownerProjectId: string | null
  /** Other ports in the project's list that are free, offered as an alternative. */
  alternatives: number[]
}

/** How a log line is classified, for the errors/warnings filter. */
export type LogLevel = 'info' | 'warn' | 'error'

/** One line of a project's output, in the merged view. */
export interface LogLine {
  /** Monotonic across every project — the merge order, and a stable React key. */
  seq: number
  projectId: string
  /** When the chunk carrying this line arrived. */
  at: number
  level: LogLevel
  /** The line with its ANSI escapes stripped and trailing space trimmed. */
  text: string
}

export interface LogQuery {
  /** Case-insensitive substring match against the line text. */
  search?: string
  /** Restrict to these projects. Empty or absent means all of them. */
  projectIds?: string[]
  /** Restrict to these levels. Empty or absent means all of them. */
  levels?: LogLevel[]
  /** Newest N matches. Defaults to 2000. */
  limit?: number
}

/** One sample of what a project's process tree is costing. */
export interface ProjectResources {
  projectId: string
  /** Percent of one core, summed across the tree. Can exceed 100. */
  cpu: number
  memoryBytes: number
  /** How many processes the tree contains, including the shell Runner spawned. */
  processes: number
}

export interface ConfigValidationIssue {
  path: string
  message: string
}

export type SaveConfigResult =
  | { ok: true; config: RunnerConfig }
  | { ok: false; issues: ConfigValidationIssue[] }
