import type { NotificationConfig, ProjectRuntime } from './types.js'

export interface Alert {
  title: string
  body?: string
}

/**
 * Whether a runtime change is worth interrupting someone for, and what to say.
 *
 * Kept apart from the sending so it can be tested without Electron, and
 * because the decision is the part with the judgement in it.
 *
 * Transitions, not states: a project that *is* crashed is not news every time
 * its runtime is re-emitted, and runtime events fire for port polls and
 * elapsed-time ticks as well as for real changes.
 */
export function decide(
  before: ProjectRuntime,
  next: ProjectRuntime,
  name: string,
  config: NotificationConfig
): Alert | null {
  if (!config.enabled) return null
  if (before.status === next.status && before.portsBusy === next.portsBusy) return null

  if (next.status === 'running' && before.status !== 'running') {
    if (config.failuresOnly) return null
    const port = next.detectedPorts[0] ?? next.port
    return { title: `${name} is ready`, ...(port ? { body: `Listening on port ${port}` } : {}) }
  }

  if (next.status === 'error' && before.status !== 'error') {
    return { title: `${name} failed to start`, ...(next.message ? { body: next.message } : {}) }
  }

  if (next.status === 'exited' && before.status !== 'exited') {
    const body = [
      next.exitCode !== null ? `Exited with code ${next.exitCode}` : null,
      // The retry count matters only when something is actually retrying.
      next.restartAttempts > 0 ? `restart attempt ${next.restartAttempts}` : null
    ]
      .filter(Boolean)
      .join(' · ')
    return { title: `${name} crashed`, ...(body ? { body } : {}) }
  }

  // Losing the last free port means this project can no longer be started.
  // Worth saying, because nothing else will until Run is pressed.
  if (!before.portsBusy && next.portsBusy && next.status === 'stopped') {
    return {
      title: `${name} has no free port`,
      body: 'Every port it is allowed to use is taken.'
    }
  }

  // Everything else — a stop the user asked for above all — is not news.
  return null
}
