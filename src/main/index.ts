import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { randomUUID } from 'node:crypto'
import type {
  DiscoveredProject,
  LogQuery,
  ExternalProcess,
  PortConflict,
  ProjectGit,
  ProjectConfig,
  RepoInfo,
  RunnerConfig,
  SaveConfigResult
} from '../shared/types.js'
import { configPath, expandPath, loadConfig, newProject, readConfigRaw, validateConfig, writeConfig } from './config.js'
import { ProcessManager } from './process-manager.js'
import { Orchestrator } from './orchestrator.js'
import { defaultRoots, fallbackCommand, inspect, scan, tildify } from './discovery.js'
import { LogStore } from './log-store.js'
import { classify, killOwner } from './port-conflict.js'
import { forgetRepos, gitStatus, repoInfo } from './git.js'
import { sweep } from './processes.js'
import { Notifier } from './notify.js'
import { isPortFree, waitForPortsFree } from './ports.js'

let mainWindow: BrowserWindow | null = null
let config: RunnerConfig = { projects: [] }
const manager = new ProcessManager()
const orchestrator = new Orchestrator(manager, () => config.projects)
const logs = new LogStore()
const notifier = new Notifier(
  (id) => findProject(id)?.name ?? null,
  (id) => {
    // Clicking a notification should land you on the project it is about.
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    send('project:focus', id)
  },
  () => config.notifications ?? { enabled: true }
)

/** How often stopped projects are re-checked for port availability. */
const PORT_POLL_MS = 4_000
let portPoll: NodeJS.Timeout | null = null

/**
 * How often the machine is swept for dev servers Runner did not start.
 *
 * Slower than the port poll: this shells out to `lsof` and `ps`, and a process
 * someone started by hand in a terminal is not something that needs noticing
 * within a second.
 */
const SWEEP_MS = 6_000
let sweepPoll: NodeJS.Timeout | null = null
let externals: ExternalProcess[] = []

async function refreshExternals(): Promise<void> {
  const found = await sweep(
    config.projects,
    (projectId) => manager.isRunning(projectId),
    (projectId) => {
      const project = findProject(projectId)
      return project ? (repoCache.get(project.id) ?? null) : null
    }
  )
  // Only tell the renderer when something actually changed; this fires every
  // few seconds and would otherwise re-render the sidebar for nothing.
  if (JSON.stringify(found) === JSON.stringify(externals)) return
  externals = found
  send('externals:update', externals)
}

/** Repository per project, kept warm so the sweep does not re-shell for it. */
const repoCache = new Map<string, RepoInfo | null>()

async function refreshRepos(): Promise<void> {
  for (const project of config.projects) {
    repoCache.set(project.id, await repoInfo(project.cwd ?? project.path))
  }
}

function refreshPorts(): void {
  void manager.refreshPortAvailability(config.projects)
}

/** Set once the user has confirmed the quit, so the second `before-quit` passes through. */
let quitConfirmed = false

function findProject(id: string): ProjectConfig | undefined {
  return config.projects.find((p) => p.id === id)
}

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 520,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#16181d',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

manager.on('data', (projectId, chunk) => {
  send('pty:data', projectId, chunk)
  // The merged view reads the same stream rather than a second capture path,
  // so the two can never disagree about what a project said.
  logs.ingest(projectId, chunk)
})
manager.on('runtime', (runtime) => {
  // A project that exits without a trailing newline still has a last line.
  if (runtime.status === 'exited' || runtime.status === 'error') logs.flush(runtime.id)
  notifier.observe(runtime)
  send('runtime:update', runtime)
})
logs.on('line', (line) => send('logs:line', line))
// Auto-open is decided in the process manager, which watches the port; the
// browser itself is the main process's to reach.
manager.on('open', (_projectId, url) => void shell.openExternal(url))

/** Applies a validated config and tells everyone about it. */
function adopt(next: RunnerConfig): void {
  config = next
  writeConfig(config)
  const live = new Set(config.projects.map((p) => p.id))
  manager.prune(live)
  logs.prune(live)
  notifier.forget(live)
  forgetRepos()
  repoCache.clear()
  void refreshRepos().then(refreshExternals)
  send('config:changed', config)
  // A project may have just gained or lost a port list.
  refreshPorts()
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => config)
  ipcMain.handle('config:raw', () => readConfigRaw())
  ipcMain.handle('config:path', () => configPath())

  ipcMain.handle('config:save', (_event, next: RunnerConfig): SaveConfigResult => {
    const result = validateConfig(next)
    if (!result.ok) return result
    adopt(result.config)
    return { ok: true, config }
  })

  ipcMain.handle('config:saveRaw', (_event, text: string): SaveConfigResult => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return {
        ok: false,
        issues: [{ path: '', message: error instanceof Error ? error.message : 'Invalid JSON.' }]
      }
    }
    const result = validateConfig(parsed)
    if (!result.ok) return result
    adopt(result.config)
    return { ok: true, config }
  })

  ipcMain.handle('config:newProject', () => newProject())

  // --- discovery ---------------------------------------------------------

  ipcMain.handle('discovery:roots', () =>
    config.scanRoots?.length ? config.scanRoots : defaultRoots()
  )

  ipcMain.handle('discovery:scan', (_event, roots: string[]): DiscoveredProject[] =>
    scan(roots, config.projects.map((project) => project.path))
  )

  /**
   * Adds scanned projects to the config.
   *
   * Names are made unique on the way in — two repos called `api` under
   * different roots is normal, and validation rejects duplicates — and `port`
   * is deliberately left unset. Guessing a port would be worse than not
   * managing one, which Runner already handles.
   */
  ipcMain.handle('discovery:add', (_event, found: DiscoveredProject[]): SaveConfigResult => {
    const taken = new Set(config.projects.map((project) => project.name))
    const added: ProjectConfig[] = []

    for (const project of found) {
      let name = project.name
      for (let n = 2; taken.has(name); n += 1) name = `${project.name} (${n})`
      taken.add(name)

      added.push({
        id: randomUUID(),
        name,
        path: tildify(project.path),
        runCommand: project.suggestedCommand ?? fallbackCommand(project.packageManager)
      })
    }

    const result = validateConfig({ ...config, projects: [...config.projects, ...added] })
    if (!result.ok) return result
    adopt(result.config)
    return { ok: true, config }
  })

  ipcMain.handle('discovery:saveRoots', (_event, roots: string[]): SaveConfigResult => {
    const result = validateConfig({ ...config, scanRoots: roots })
    if (!result.ok) return result
    adopt(result.config)
    return { ok: true, config }
  })

  // Start pulls the whole dependency tree up; startOnly is the escape hatch for
  // when the dependencies are already running in a terminal somewhere.
  ipcMain.handle('project:start', async (_event, id: string) => {
    if (!findProject(id)) return
    await orchestrator.startTree(id)
    refreshPorts()
  })

  ipcMain.handle('project:startOnly', async (_event, id: string) => {
    const project = findProject(id)
    if (project) await manager.start(project)
  })

  ipcMain.handle('project:stop', async (_event, id: string) => {
    if (!findProject(id)) return
    await orchestrator.stopTree(id)
    setTimeout(refreshPorts, 800)
  })

  ipcMain.handle('project:stopOnly', (_event, id: string) => {
    orchestrator.cancel(id)
    manager.stop(id, findProject(id))
    setTimeout(refreshPorts, 800)
  })

  ipcMain.handle('project:restart', async (_event, id: string) => {
    const project = findProject(id)
    if (project) await manager.restart(project)
  })

  // --- git ---------------------------------------------------------------

  /**
   * Places every project in its repository.
   *
   * Repositories are identified by their common git directory rather than
   * their path, so two worktrees of one repo are recognised as the same
   * repository even though they are different directories.
   */
  ipcMain.handle('git:projects', async (): Promise<ProjectGit[]> =>
    Promise.all(
      config.projects.map(async (project) => {
        const dir = project.cwd ?? project.path
        const [repo, status] = await Promise.all([repoInfo(dir), gitStatus(dir)])
        const here = expandPath(dir)
        return {
          projectId: project.id,
          repo,
          worktree: repo?.worktrees.find((w) => w.path === here) ?? null,
          status
        }
      })
    )
  )

  /**
   * Worktrees of projects you already have, that are not themselves configured.
   *
   * This is the discoverable half: having added one checkout of a repository,
   * the others are exactly the things you are most likely to want next.
   */
  ipcMain.handle('git:unconfigured', async (): Promise<DiscoveredProject[]> => {
    const configured = new Set(config.projects.map((p) => expandPath(p.cwd ?? p.path)))
    const seen = new Set<string>()
    const found: DiscoveredProject[] = []

    for (const project of config.projects) {
      const repo = await repoInfo(project.cwd ?? project.path)
      if (!repo) continue
      for (const worktree of repo.worktrees) {
        if (configured.has(worktree.path) || seen.has(worktree.path)) continue
        seen.add(worktree.path)
        const detected = inspect(worktree.path)
        if (!detected) continue
        // Every checkout of a repository shares one package.json, so the name
        // in it is the same for all of them. The directory is what actually
        // tells two worktrees apart, so it wins here — unlike a plain folder
        // scan, where the package name is the better answer.
        found.push({
          ...detected,
          name: worktree.path.split('/').filter(Boolean).pop() ?? detected.name
        })
      }
    }
    return found
  })

  ipcMain.handle('git:refresh', () => {
    forgetRepos()
  repoCache.clear()
  void refreshRepos().then(refreshExternals)
    repoCache.clear()
    void refreshRepos()
  })

  ipcMain.handle('processes:external', () => externals)

  // --- port conflicts ----------------------------------------------------

  /**
   * Who is holding each of a project's ports that is currently busy.
   *
   * Empty when the project can start. One entry per busy port rather than just
   * the first: when a project lists three ports and all three are taken, the
   * useful answer names all three.
   */
  ipcMain.handle('ports:inspect', async (_event, id: string): Promise<PortConflict[]> => {
    const project = findProject(id)
    if (!project?.port?.length) return []

    const states = await Promise.all(
      project.port.map(async (port) => ({ port, free: await isPortFree(port) }))
    )
    const free = states.filter((s) => s.free).map((s) => s.port)
    const busy = states.filter((s) => !s.free).map((s) => s.port)

    return Promise.all(
      busy.map((port) =>
        classify(
          project,
          port,
          config.projects,
          (owner) => manager.runtime(owner).pid,
          free
        )
      )
    )
  })

  /**
   * Frees a port and starts the project that wanted it.
   *
   * A Runner-owned process is stopped through the orchestrator rather than
   * signalled behind its own back, so its dependency tree and auto-restart
   * budget are handled the way a deliberate stop always is.
   */
  ipcMain.handle(
    'ports:resolve',
    async (_event, conflict: PortConflict): Promise<{ ok: boolean; message?: string }> => {
      const project = findProject(conflict.projectId)
      if (!project) return { ok: false, message: 'That project no longer exists.' }

      if (conflict.tier === 'unknown' || !conflict.owner) {
        return { ok: false, message: 'Runner will not kill a process it cannot identify.' }
      }

      if (conflict.tier === 'runner' && conflict.ownerProjectId) {
        orchestrator.cancel(conflict.ownerProjectId)
        manager.stop(conflict.ownerProjectId, findProject(conflict.ownerProjectId))
        const freed = await waitForPortsFree([conflict.port], 8_000)
        if (!freed) return { ok: false, message: `Port ${conflict.port} did not come back.` }
      } else {
        const result = await killOwner(conflict.owner, conflict.port)
        if (!result.ok) return { ok: false, message: result.reason }
      }

      await orchestrator.startTree(project.id)
      refreshPorts()
      return { ok: true }
    }
  )

  ipcMain.handle('logs:query', (_event, query: LogQuery) => logs.query(query))
  ipcMain.handle('logs:clear', (_event, projectId?: string) => logs.clear(projectId))

  ipcMain.handle('runtime:all', () => manager.allRuntimes())
  ipcMain.handle('pty:buffer', (_event, id: string) => manager.buffer(id))
  ipcMain.handle('pty:clear', (_event, id: string) => manager.clearBuffer(id))

  ipcMain.on('pty:input', (_event, id: string, data: string) => manager.input(id, data))
  ipcMain.on('pty:resize', (_event, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )

  ipcMain.handle('shell:openExternal', (_event, url: string) => shell.openExternal(url))

  ipcMain.handle('shell:openPath', (_event, path: string) =>
    shell.openPath(expandPath(path))
  )

  /** Writes text to a file the user picks. Returns the path, or null if cancelled. */
  ipcMain.handle('dialog:saveText', async (_event, suggested: string, body: string) => {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: suggested })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, body, 'utf8')
    return result.filePath
  })

  ipcMain.handle('dialog:pickDirectory', async (_event, current?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current ? expandPath(current) : undefined
    })
    return result.canceled ? null : result.filePaths[0]
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.zhiganov.runner')
  app.on('browser-window-created', (_event, window) => optimizer.watchWindowShortcuts(window))

  config = loadConfig()
  registerIpc()
  createWindow()

  refreshPorts()
  portPoll = setInterval(refreshPorts, PORT_POLL_MS)

  void refreshRepos().then(refreshExternals)
  sweepPoll = setInterval(() => void refreshExternals(), SWEEP_MS)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (quitConfirmed || manager.runningCount() === 0) return

  event.preventDefault()
  const running = manager.runningCount()
  const prompt = {
    type: 'question' as const,
    buttons: ['Quit and stop', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Stop ${running} running ${running === 1 ? 'app' : 'apps'}?`,
    detail: 'Quitting Runner shuts down every app it started.'
  }
  const choice =
    mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBoxSync(mainWindow, prompt)
      : dialog.showMessageBoxSync(prompt)
  if (choice !== 0) return

  quitConfirmed = true
  if (portPoll) clearInterval(portPoll)
  if (sweepPoll) clearInterval(sweepPoll)
  manager.stopAll().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  // Standard macOS behaviour is to stay in the dock, but a dev-server manager
  // with no window is a trap, so quit (which triggers the teardown above).
  app.quit()
})
