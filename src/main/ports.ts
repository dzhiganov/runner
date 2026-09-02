import { createServer, createConnection } from 'node:net'

const CONNECT_TIMEOUT_MS = 300
/** Loopback addresses a local dev server realistically listens on. */
const LOOPBACK = ['127.0.0.1', '::1']
/** Wildcard addresses to test-bind against. */
const WILDCARD = ['0.0.0.0', '::']

/**
 * True when a TCP connect to `host:port` is accepted, i.e. something is
 * already serving there.
 *
 * A bind probe alone is not enough: Node sets SO_REUSEADDR, so binding
 * 127.0.0.1 succeeds while another process holds `::` (and vice versa), which
 * would hand the same port to two apps.
 */
function isListening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const done = (result: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** True when we can claim `port` on `host` ourselves. */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      // A machine without IPv6 cannot bind `::`; that is not a busy port.
      resolve(error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL')
    })
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

/** True when nothing is serving on `port` and we could bind it. */
export async function isPortFree(port: number): Promise<boolean> {
  const listening = await Promise.all(LOOPBACK.map((host) => isListening(port, host)))
  if (listening.some(Boolean)) return false

  const binds = await Promise.all(WILDCARD.map((host) => canBind(port, host)))
  return binds.every(Boolean)
}

/**
 * First free port from the preferred list, or null when every one is taken.
 *
 * The list is authoritative — Runner never invents a port outside it. That is
 * what lets the UI tell the user up front that a project has nowhere to run,
 * rather than silently starting it somewhere they were not expecting.
 */
export async function resolvePort(preferred: number[]): Promise<number | null> {
  for (const port of preferred) {
    if (await isPortFree(port)) return port
  }
  return null
}

/** Whether at least one of these ports is currently available. */
export async function anyPortFree(ports: number[]): Promise<boolean> {
  return (await resolvePort(ports)) !== null
}

/** True when something is accepting connections on `port`, i.e. a server is up. */
export async function isPortServing(port: number): Promise<boolean> {
  const results = await Promise.all(LOOPBACK.map((host) => isListening(port, host)))
  return results.some(Boolean)
}

/**
 * Resolves once `port` starts answering, or false on timeout/abort.
 *
 * This is how a dependency is judged ready: a dependent that connects the
 * instant its parent's process exists would race the server's own bind.
 */
export async function waitForPort(
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
  intervalMs = 250
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return false
    if (await isPortServing(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Resolves once at least one of `ports` is free again, or false on timeout.
 *
 * A restart needs this. Killing the process group ends the shell Runner is
 * attached to, but the dev server it spawned closes its listening socket a
 * moment later — so a start issued the instant the PTY exits finds its own
 * ports still taken and refuses to run. Waiting for the port to actually come
 * back is the difference between "restart" and "restart, then click it again".
 */
export async function waitForPortsFree(
  ports: number[],
  timeoutMs: number,
  intervalMs = 150
): Promise<boolean> {
  if (!ports.length) return true
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await anyPortFree(ports)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
