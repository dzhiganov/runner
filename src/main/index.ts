import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { randomUUID } from 'node:crypto'
import type {
  DiscoveredProject,
  LogQuery,
  ProjectConfig,
  RunnerConfig,
  SaveConfigResult
} from '../shared/types.js'
import { configPath, expandPath, loadConfig, newProject, readConfigRaw, validateConfig, writeConfig } from './config.js'
import { ProcessManager } from './process-manager.js'
import { Orchestrator } from './orchestrator.js'
import { defaultRoots, fallbackCommand, scan, tildify } from './discovery.js'
import { LogStore } from './log-store.js'

let mainWindow: BrowserWindow | null = null
let config: RunnerConfig = { projects: [] }
const manager = new ProcessManager()
const orchestrator = new Orchestrator(manager, () => config.projects)
const logs = new LogStore()

/** How often stopped projects are re-checked for port availability. */
const PORT_POLL_MS = 4_000
let portPoll: NodeJS.Timeout | null = null

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
  manager.stopAll().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  // Standard macOS behaviour is to stay in the dock, but a dev-server manager
  // with no window is a trap, so quit (which triggers the teardown above).
  app.quit()
})
