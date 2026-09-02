import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

const THEME = {
  background: '#0f1116',
  foreground: '#d7dae0',
  cursor: '#7aa2f7',
  selectionBackground: '#2c3a5a',
  black: '#1b1e26',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#565f89'
}

interface Pane {
  el: HTMLDivElement
  term: Terminal
  fit: FitAddon
  /** Chunks that arrive while the initial scrollback is still being fetched. */
  pending: string[]
  ready: boolean
}

interface Props {
  activeId: string | null
  /** Bumped by the parent to force a refit, e.g. after the sidebar resizes. */
  layoutKey?: number
}

/**
 * Keeps one long-lived xterm instance per project so switching tabs preserves
 * scrollback, scroll position and selection. Panes are hidden, never unmounted.
 */
export default function TerminalHost({ activeId, layoutKey = 0 }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const panes = useRef(new Map<string, Pane>())
  const activeRef = useRef<string | null>(activeId)
  activeRef.current = activeId

  const ensurePane = (id: string): Pane => {
    const existing = panes.current.get(id)
    if (existing) return existing

    const el = document.createElement('div')
    el.className = 'term-pane'
    el.style.display = 'none'
    hostRef.current?.appendChild(el)

    const term = new Terminal({
      fontFamily: 'SFMono-Regular, Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_event, uri) => window.runner.openExternal(uri)))
    term.open(el)
    term.onData((data) => window.runner.sendInput(id, data))
    term.onResize(({ cols, rows }) => window.runner.resize(id, cols, rows))

    const pane: Pane = { el, term, fit, pending: [], ready: false }
    panes.current.set(id, pane)

    // Replay whatever the main process already buffered, then flush anything
    // that streamed in while we were waiting on the IPC round trip.
    window.runner.getBuffer(id).then((buffer) => {
      if (buffer) term.write(buffer)
      pane.pending.forEach((chunk) => term.write(chunk))
      pane.pending = []
      pane.ready = true
    })

    return pane
  }

  useEffect(() => {
    const off = window.runner.onData((id, chunk) => {
      const pane = panes.current.get(id)
      if (!pane) return
      if (pane.ready) pane.term.write(chunk)
      else pane.pending.push(chunk)
    })
    return off
  }, [])

  useEffect(() => {
    const onResize = (): void => {
      const id = activeRef.current
      if (!id) return
      panes.current.get(id)?.fit.fit()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    for (const [id, pane] of panes.current) {
      pane.el.style.display = id === activeId ? 'block' : 'none'
    }
    if (!activeId) return
    const pane = ensurePane(activeId)
    pane.el.style.display = 'block'
    // Let the browser apply the display change before measuring.
    const timer = window.setTimeout(() => {
      pane.fit.fit()
      pane.term.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeId, layoutKey])

  useEffect(() => {
    const map = panes.current
    return () => {
      for (const pane of map.values()) pane.term.dispose()
      map.clear()
    }
  }, [])

  return <div className="term-host" ref={hostRef} />
}
