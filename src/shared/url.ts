import type { ProjectConfig } from './types.js'

/** `{port}` and `$PORT` both stand for the port being opened. */
const PORT_PLACEHOLDER = /\{port\}|\$PORT\b/gi
const FULL_URL = /^https?:\/\//i

/**
 * Characters a WHATWG URL leaves as they are but RFC 3986 does not allow.
 * Stricter openers refuse a URL containing them, so they are escaped too.
 */
const LOOSE_CHARS = /[|^`{}\\]/g

/**
 * Whether `url` is something Runner hands to the browser. Only http and https:
 * a `file:`, `smb:` or custom-scheme URL passed to the OS opener can launch
 * an application, and a link in a dev server's output is not trusted input.
 */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The URL Runner opens for a project running on `port`.
 *
 * Without a `startUrl` that is the root of the port, as it always was. A path
 * is appended to it; a full URL replaces it, which is how a project served
 * under a hostname other than localhost is reached. Either may name the port
 * with a placeholder, since which port is free is only known at run time.
 *
 * `useStartUrl` is false for a project's secondary ports — the extra servers
 * an Nx `run-many` announces. The start URL describes the project's main
 * server; applied to every port, a full URL would send each link to the same
 * page, and a path would point the others at a route they may not have.
 */
export function projectUrl(
  project: Pick<ProjectConfig, 'protocol' | 'startUrl'>,
  port: number,
  useStartUrl = true
): string {
  const root = `${project.protocol ?? 'http'}://localhost:${port}`
  const start = useStartUrl ? (project.startUrl ?? '').trim() : ''
  if (!start || startUrlProblem(start)) return root
  const filled = start.replace(PORT_PLACEHOLDER, String(port))
  const url = new URL(FULL_URL.test(filled) ? filled : `${root}${filled}`)
  const rest = `${url.pathname}${url.search}${url.hash}`
  return url.origin + rest.replace(LOOSE_CHARS, encodeURIComponent)
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
  let url: URL
  try {
    url = new URL(full ? sample : `http://localhost:3000${sample}`)
  } catch {
    return 'Not a valid URL.'
  }
  // `http://localhost:{port}@elsewhere/` reads as localhost and is not.
  if (url.username || url.password) return 'A start URL cannot contain a user name or password.'
  return null
}
