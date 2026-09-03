import { contextBridge, ipcRenderer } from 'electron'
import type {
  DiscoveredProject,
  LogLine,
  LogQuery,
  ExternalProcess,
  PortConflict,
  ProjectGit,
  ProjectConfig,
  ProjectRuntime,
  RunnerConfig,
  SaveConfigResult
} from '../shared/types.js'

const api = {
  getConfig: (): Promise<RunnerConfig> => ipcRenderer.invoke('config:get'),
  getConfigRaw: (): Promise<string> => ipcRenderer.invoke('config:raw'),
  getConfigPath: (): Promise<string> => ipcRenderer.invoke('config:path'),
  saveConfig: (config: RunnerConfig): Promise<SaveConfigResult> =>
    ipcRenderer.invoke('config:save', config),
  saveConfigRaw: (text: string): Promise<SaveConfigResult> =>
    ipcRenderer.invoke('config:saveRaw', text),
  newProject: (): Promise<ProjectConfig> => ipcRenderer.invoke('config:newProject'),

  /** Configured scan roots, or likely ones when discovery is not set up yet. */
  getScanRoots: (): Promise<string[]> => ipcRenderer.invoke('discovery:roots'),
  saveScanRoots: (roots: string[]): Promise<SaveConfigResult> =>
    ipcRenderer.invoke('discovery:saveRoots', roots),
  /** Walks the roots, omitting anything already in the config. */
  scanProjects: (roots: string[]): Promise<DiscoveredProject[]> =>
    ipcRenderer.invoke('discovery:scan', roots),
  addDiscovered: (found: DiscoveredProject[]): Promise<SaveConfigResult> =>
    ipcRenderer.invoke('discovery:add', found),

  /** Starts the project and everything it depends on, deepest first. */
  start: (id: string): Promise<void> => ipcRenderer.invoke('project:start', id),
  /** Starts just this project, leaving its dependencies alone. */
  startOnly: (id: string): Promise<void> => ipcRenderer.invoke('project:startOnly', id),
  /** Stops the project and the dependencies nothing else is using. */
  stop: (id: string): Promise<void> => ipcRenderer.invoke('project:stop', id),
  stopOnly: (id: string): Promise<void> => ipcRenderer.invoke('project:stopOnly', id),
  /** Stops the project, waits for its ports to come back, and starts it again. */
  restart: (id: string): Promise<void> => ipcRenderer.invoke('project:restart', id),

  /** Dev servers running outside Runner, attributed to the projects they are in. */
  getExternals: (): Promise<ExternalProcess[]> => ipcRenderer.invoke('processes:external'),

  /** Every project placed in its repository, with the worktree it is. */
  getProjectGit: (): Promise<ProjectGit[]> => ipcRenderer.invoke('git:projects'),
  /** Worktrees of configured repositories that are not themselves projects. */
  getUnconfiguredWorktrees: (): Promise<DiscoveredProject[]> =>
    ipcRenderer.invoke('git:unconfigured'),
  /** Drops cached git information, so the next read is fresh. */
  refreshGit: (): Promise<void> => ipcRenderer.invoke('git:refresh'),

  /** Who holds each of a project's busy ports. Empty when it can start. */
  inspectPorts: (id: string): Promise<PortConflict[]> => ipcRenderer.invoke('ports:inspect', id),
  /** Frees the port and starts the project. Refuses the unknown tier. */
  resolvePortConflict: (conflict: PortConflict): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('ports:resolve', conflict),

  /** Merged, filtered lines from every project. Oldest first. */
  queryLogs: (query: LogQuery): Promise<LogLine[]> => ipcRenderer.invoke('logs:query', query),
  /** Clears the merged view, for one project or all of them. */
  clearLogs: (projectId?: string): Promise<void> => ipcRenderer.invoke('logs:clear', projectId),

  getRuntimes: (): Promise<ProjectRuntime[]> => ipcRenderer.invoke('runtime:all'),
  getBuffer: (id: string): Promise<string> => ipcRenderer.invoke('pty:buffer', id),
  clearBuffer: (id: string): Promise<void> => ipcRenderer.invoke('pty:clear', id),

  sendInput: (id: string, data: string): void => ipcRenderer.send('pty:input', id, data),
  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('pty:resize', id, cols, rows),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),
  pickDirectory: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickDirectory', current),
  /** Saves text to a file the user picks. Resolves to the path, or null if cancelled. */
  saveText: (suggested: string, body: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveText', suggested, body),

  onData: (handler: (id: string, chunk: string) => void): (() => void) => {
    const listener = (_e: unknown, id: string, chunk: string): void => handler(id, chunk)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.off('pty:data', listener)
  },
  onLogLine: (handler: (line: LogLine) => void): (() => void) => {
    const listener = (_e: unknown, line: LogLine): void => handler(line)
    ipcRenderer.on('logs:line', listener)
    return () => ipcRenderer.off('logs:line', listener)
  },
  onExternals: (handler: (found: ExternalProcess[]) => void): (() => void) => {
    const listener = (_e: unknown, found: ExternalProcess[]): void => handler(found)
    ipcRenderer.on('externals:update', listener)
    return () => ipcRenderer.off('externals:update', listener)
  },
  onRuntime: (handler: (runtime: ProjectRuntime) => void): (() => void) => {
    const listener = (_e: unknown, runtime: ProjectRuntime): void => handler(runtime)
    ipcRenderer.on('runtime:update', listener)
    return () => ipcRenderer.off('runtime:update', listener)
  },
  onConfigChanged: (handler: (config: RunnerConfig) => void): (() => void) => {
    const listener = (_e: unknown, config: RunnerConfig): void => handler(config)
    ipcRenderer.on('config:changed', listener)
    return () => ipcRenderer.off('config:changed', listener)
  }
}

export type RunnerApi = typeof api

contextBridge.exposeInMainWorld('runner', api)
