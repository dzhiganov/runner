import { contextBridge, ipcRenderer } from 'electron'
import type {
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

  /** Starts the project and everything it depends on, deepest first. */
  start: (id: string): Promise<void> => ipcRenderer.invoke('project:start', id),
  /** Starts just this project, leaving its dependencies alone. */
  startOnly: (id: string): Promise<void> => ipcRenderer.invoke('project:startOnly', id),
  /** Stops the project and the dependencies nothing else is using. */
  stop: (id: string): Promise<void> => ipcRenderer.invoke('project:stop', id),
  stopOnly: (id: string): Promise<void> => ipcRenderer.invoke('project:stopOnly', id),
  /** Stops the project, waits for its ports to come back, and starts it again. */
  restart: (id: string): Promise<void> => ipcRenderer.invoke('project:restart', id),

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

  onData: (handler: (id: string, chunk: string) => void): (() => void) => {
    const listener = (_e: unknown, id: string, chunk: string): void => handler(id, chunk)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.off('pty:data', listener)
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
