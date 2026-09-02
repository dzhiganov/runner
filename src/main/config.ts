import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProjectConfig, RunnerConfig } from '../shared/types.js'
import { migrate, validateConfig } from './config-validate.js'
import { expandPath } from './paths.js'

const DEFAULT_CONFIG: RunnerConfig = {
  projects: [
    {
      id: randomUUID(),
      name: 'my app',
      path: '~/Documents/projects/my-app',
      runCommand: 'npm run dev',
      port: [3000, 3001, 3002]
    }
  ]
}

export function configPath(): string {
  return join(app.getPath('userData'), 'projects.json')
}

export { expandPath }
export { validateConfig, migrate }

/** Reads the config from disk, seeding a default file on first run. */
export function loadConfig(): RunnerConfig {
  const file = configPath()
  if (!existsSync(file)) {
    writeConfig(DEFAULT_CONFIG)
    return DEFAULT_CONFIG
  }
  try {
    const parsed = migrate(JSON.parse(readFileSync(file, 'utf8')))
    const result = validateConfig(parsed)
    if (result.ok) {
      // Persist the migration, so the raw-JSON editor and the file on disk
      // agree with what the app is actually running.
      writeConfig(result.config)
      return result.config
    }
    // A hand-edited file that no longer validates should not wipe the user's
    // data, so surface what we can and leave the file untouched.
    console.error('Invalid config on disk:', result.issues)
    return { projects: [] }
  } catch (error) {
    console.error('Could not parse config:', error)
    return { projects: [] }
  }
}

export function readConfigRaw(): string {
  const file = configPath()
  if (!existsSync(file)) writeConfig(DEFAULT_CONFIG)
  return readFileSync(file, 'utf8')
}

export function writeConfig(config: RunnerConfig): void {
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export function newProject(): ProjectConfig {
  return {
    id: randomUUID(),
    name: 'New project',
    path: '~/',
    runCommand: 'npm run dev',
    port: [3000]
  }
}
