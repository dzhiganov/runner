import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Expand a leading `~` and resolve to an absolute path. */
export function expandPath(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  const expanded = trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}
