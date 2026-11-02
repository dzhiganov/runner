import type { ProjectConfig } from './types.js'

/** `{port}` and `$PORT` both stand for the port being opened. */
const PORT_PLACEHOLDER = /\{port\}|\$PORT\b/gi
const FULL_URL = /^https?:\/\//i

/**
 * The URL Runner opens for a project running on `port`.
 *
 * Without a `startUrl` that is the root of the port, as it always was. A path
 * is appended to it; a full URL replaces it, which is how a project served
 * under a hostname other than localhost is reached. Either may name the port
 * with a placeholder, since which port is free is only known at run time.
 */
export function projectUrl(
  project: Pick<ProjectConfig, 'protocol' | 'startUrl'>,
  port: number
): string {
  const start = (project.startUrl ?? '').trim().replace(PORT_PLACEHOLDER, String(port))
  if (FULL_URL.test(start)) return start
  const path = start.startsWith('/') ? start : ''
  return `${project.protocol ?? 'http'}://localhost:${port}${path}`
}

/**
 * Why `value` cannot be used as a start URL, or null when it can. Blank is
 * fine: it means the root of the port.
 *
 * Shared by config validation and the form, so the form can say what is wrong
 * while it is being typed rather than only on save.
 */
export function startUrlProblem(value: string): string | null {
  const text = value.trim()
  if (!text) return null
  if (/\s/.test(text)) return 'A start URL cannot contain spaces.'
  const full = FULL_URL.test(text)
  if (!full && !text.startsWith('/')) {
    return 'Use a path starting with /, or a full http:// or https:// URL.'
  }
  const sample = text.replace(PORT_PLACEHOLDER, '3000')
  if (/\{[^}]*\}/.test(sample)) return 'Only {port} and $PORT are filled in.'
  try {
    new URL(full ? sample : `http://localhost:3000${sample}`)
  } catch {
    return 'Not a valid URL.'
  }
  return null
}
