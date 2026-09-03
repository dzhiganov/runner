import { EventEmitter } from 'node:events'
import type { LogLevel, LogLine, LogQuery } from '../shared/types.js'

/**
 * Lines retained across every project.
 *
 * The per-project PTY buffers are capped in characters because a terminal is
 * scrolled by the eye; this is capped in lines because it is filtered and
 * searched, and a line is the unit both work on. A dev server left up all day
 * would otherwise grow it without limit.
 */
const MAX_LINES = 20_000

/** Dropped in one go when the cap is hit, so trimming is not a per-line cost. */
const TRIM_TO = 18_000

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g

/**
 * SGR colours that mean "something went wrong", as written by the ANSI escapes
 * a dev server actually emits: 31/91 red, 33/93 yellow, and the 38;5;n form.
 */
const RED_SGR = /\x1B\[(?:[0-9;]*;)?(?:1;)?(?:9[1]|31)(?:;[0-9]+)*m/
const YELLOW_SGR = /\x1B\[(?:[0-9;]*;)?(?:1;)?(?:9[3]|33)(?:;[0-9]+)*m/

/**
 * Words that mark a line as an error or a warning when nothing coloured it.
 *
 * Deliberately anchored to a word boundary and case-sensitive for the
 * all-caps forms: `error` appears inside `errorHandler.ts` and in perfectly
 * happy webpack output, and colouring those red would make the filter useless.
 */
const ERROR_TEXT = /(^|[\s[(])(ERROR|ERR!|FATAL|Error:|error:)([\s\]):]|$)/
const WARN_TEXT = /(^|[\s[(])(WARN|WARNING|Warning:|warning:|DeprecationWarning)([\s\]):]|$)/

export interface LogStoreEvents {
  line: [line: LogLine]
}

/**
 * The merged, line-oriented view of every project's output.
 *
 * This does not replace the per-project PTY buffers — those keep their control
 * sequences because that is the point of a terminal. This is the other half:
 * plain lines, tagged and timestamped, for the question "which of my seven
 * services just threw that error".
 */
export class LogStore extends EventEmitter<LogStoreEvents> {
  private lines: LogLine[] = []
  /** Unterminated tail per project, waiting for the rest of its line. */
  private carry = new Map<string, string>()
  private nextSeq = 1

  /**
   * Splits a PTY chunk into lines and files them.
   *
   * A chunk boundary lands wherever the OS felt like it, so the tail of one
   * read is held until the newline that finishes it arrives — otherwise a line
   * split across two reads is stored, searched and filtered as two.
   */
  ingest(projectId: string, chunk: string, at = Date.now()): void {
    const text = (this.carry.get(projectId) ?? '') + chunk
    const parts = text.split('\n')
    // The last element is either an unterminated line or '' after a trailing
    // newline; either way it is not ready to be filed.
    this.carry.set(projectId, parts.pop() ?? '')

    for (const part of parts) this.push(projectId, part, at)
  }

  /**
   * Files whatever a project left unterminated, so the last line of a run is
   * not swallowed when the process exits without a trailing newline.
   */
  flush(projectId: string): void {
    const pending = this.carry.get(projectId)
    this.carry.set(projectId, '')
    if (pending?.trim()) this.push(projectId, pending, Date.now())
  }

  private push(projectId: string, raw: string, at: number): void {
    // A PTY ends its lines with CRLF, so the CR belonging to this line's own
    // terminator goes first. Without this the split below takes everything
    // after that CR — the empty string — and every line is dropped as blank.
    const terminated = raw.replace(/\r+$/, '')

    // What remains is a progress bar rewriting one line in place. The terminal
    // ends up showing the last segment, so that is what is stored; keeping
    // every intermediate frame would fill the log with a single download.
    const visible = terminated.includes('\r')
      ? (terminated.split('\r').pop() ?? terminated)
      : terminated

    const level = levelOf(visible)
    const text = visible.replace(ANSI_RE, '').replace(/\s+$/, '')
    if (!text) return

    const line: LogLine = { seq: this.nextSeq++, projectId, at, level, text }
    this.lines.push(line)

    if (this.lines.length > MAX_LINES) this.lines = this.lines.slice(-TRIM_TO)
    this.emit('line', line)
  }

  /** Most recent lines matching the query, oldest first. */
  query(query: LogQuery = {}): LogLine[] {
    const { search, projectIds, levels, limit = 2_000 } = query
    const needle = search?.trim().toLowerCase()
    const wanted = projectIds?.length ? new Set(projectIds) : null
    const levelSet = levels?.length ? new Set(levels) : null

    const matched: LogLine[] = []
    // Walked backwards so `limit` keeps the newest lines rather than the oldest.
    for (let i = this.lines.length - 1; i >= 0 && matched.length < limit; i -= 1) {
      const line = this.lines[i]
      if (wanted && !wanted.has(line.projectId)) continue
      if (levelSet && !levelSet.has(line.level)) continue
      if (needle && !line.text.toLowerCase().includes(needle)) continue
      matched.push(line)
    }
    return matched.reverse()
  }

  /** Everything, or just one project's lines. */
  clear(projectId?: string): void {
    if (!projectId) {
      this.lines = []
      this.carry.clear()
      return
    }
    this.lines = this.lines.filter((line) => line.projectId !== projectId)
    this.carry.delete(projectId)
  }

  /** Drops lines belonging to projects that no longer exist. */
  prune(keep: Set<string>): void {
    this.lines = this.lines.filter((line) => keep.has(line.projectId))
    for (const id of this.carry.keys()) if (!keep.has(id)) this.carry.delete(id)
  }

  size(): number {
    return this.lines.length
  }
}

/**
 * What kind of line this is.
 *
 * Colour is read before the escapes are stripped, and is trusted over the
 * text: a dev server that paints a line red has told us more directly than any
 * pattern match can infer.
 */
export function levelOf(raw: string): LogLevel {
  if (RED_SGR.test(raw)) return 'error'
  if (YELLOW_SGR.test(raw)) return 'warn'

  const plain = raw.replace(ANSI_RE, '')
  if (ERROR_TEXT.test(plain)) return 'error'
  if (WARN_TEXT.test(plain)) return 'warn'
  return 'info'
}
