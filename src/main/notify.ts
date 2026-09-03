import { Notification } from 'electron'
import type { NotificationConfig, ProjectRuntime } from '../shared/types.js'
import { decide } from '../shared/notify-rules.js'

/**
 * Turns runtime changes into desktop notifications.
 *
 * All the judgement lives in `decide`; this holds the previous state, talks to
 * Electron, and does nothing else.
 */
export class Notifier {
  private previous = new Map<string, ProjectRuntime>()

  constructor(
    private nameOf: (projectId: string) => string | null,
    private onClick: (projectId: string) => void,
    private settings: () => NotificationConfig
  ) {}

  /** Called for every runtime update; sends at most one notification. */
  observe(next: ProjectRuntime): void {
    const before = this.previous.get(next.id)
    this.previous.set(next.id, next)
    // Nothing to compare against on the first sighting, which is also what
    // stops a notification firing for every project at launch.
    if (!before) return

    const name = this.nameOf(next.id)
    if (!name) return

    const alert = decide(before, next, name, this.settings())
    if (!alert || !Notification.isSupported()) return

    const notification = new Notification({ title: alert.title, body: alert.body })
    notification.on('click', () => this.onClick(next.id))
    notification.show()
  }

  /** Forgets projects that no longer exist, so re-adding one starts clean. */
  forget(keep: Set<string>): void {
    for (const id of this.previous.keys()) if (!keep.has(id)) this.previous.delete(id)
  }
}
