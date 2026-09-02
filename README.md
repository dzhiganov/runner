# Runner

A macOS app for starting, restarting and stopping your local dev servers from
one window. Each project gets a real terminal, a port it is allowed to use, and
a link that opens it in your browser.

**[Download for macOS →](https://github.com/dzhiganov/runner/releases/latest)**

![Runner with a three-project stack running](docs/media/hero.png)

Projects can depend on each other, so one click brings up a whole stack in the
order it actually needs to come up in. Nothing runs in a background you can't
see: every project is a real pseudo-terminal you can type into.

---

## Running something

Click Run. The command goes to your login shell, in the project's directory,
with a free port in `PORT`. Output streams into a real terminal — colours,
spinners and progress bars behave exactly as they do in iTerm, because it *is* a
terminal, not a log pane.

![Starting a project](docs/media/start.gif)

`port` is the list of ports a project is allowed to use. Runner walks it in
order and exports the first free one as `PORT`, which Next.js, Vite, CRA,
Express and Nest all pick up with no extra configuration.

The list is authoritative. If every entry is taken, Runner does **not** invent a
port outside it — Run is disabled and hovering it says which ports are occupied.
Availability is re-checked every few seconds while a project is stopped, so the
button re-enables on its own once something frees up.

A port counts as busy if anything accepts a TCP connection on it, or if the
wildcard address cannot be bound. Both checks are needed: Node sets
`SO_REUSEADDR`, so a bind probe alone reports a port as free while another dev
server is happily listening on it.

### Ports Runner did not assign

`PORT` only ever describes one server. Commands that start several at once — an
Nx `run-many`, a monorepo dev script — ignore it, and so do tools that hard-code
their port. For those, Runner reads the ports out of the command's own output:
any `http://localhost:4200/` it prints becomes a link in the toolbar and the
sidebar. Detected ports win over the assigned one, because they are what is
actually listening.

---

## Projects that need other projects

`dependsOn` lists the projects that have to be up first. Run on a project starts
the whole tree, deepest first, and the sidebar shows it as a tree —
dependencies nested under whatever needs them, foldable.

![Starting a dependency tree](docs/media/tree.gif)

The waiting is the point. A frontend that boots while its backend is still
binding a port fails in ways that look nothing like the real problem, so a
dependent is not started until its dependencies are not merely spawned but
actually answering.

How "ready" is decided, most specific first:

1. `readiness.logPattern` — a regular expression matched against the output.
2. `readiness.port` — wait until that TCP port accepts a connection.
3. Otherwise the port Runner assigned via `PORT`.
4. With nothing to probe, ready once it has survived its first moment.

A timeout is a warning, not a failure: the dependency is up, Runner just could
not prove it is serving, so the dependent starts anyway. A dependency that
genuinely *fails* aborts the tree, and every project in it says which dependency
broke.

Stop takes the tree down too — except any dependency another running project
still needs. **Run alone** and **Stop only** skip the tree entirely, for when
the dependencies are already up somewhere else. Cycles are refused when you
save, naming the loop.

---

## Restarting

Restart stops the project, waits for it to actually let go of its ports, and
only then starts it again.

![Restarting a project](docs/media/restart.gif)

That wait is not padding. A dev server keeps its listening socket for a moment
after the shell it was spawned through is gone, so restarting the instant the
terminal exits hits the project's own leftover listener and reports every port
as busy — which is why restarting used to take two clicks.

Stopping sends `SIGTERM` to the child's whole **process group**, escalating to
`SIGKILL` after four seconds, so `npm run dev` takes vite, tsc and nodemon down
with it instead of orphaning them on the port.

### After a crash

Turn on **Restart automatically** and a project that falls over comes back by
itself, with a delay that doubles each attempt.

![Auto-restart backing off and giving up](docs/media/autorestart.gif)

Only unexpected exits count. A stop you asked for, a restart, and a clean exit
are all taken at their word — nothing comes back.

Attempts are *consecutive*, and a run that stays up for twenty seconds resets
the budget. So a project that crashes once a day is restarted every time, while
one that cannot start at all gives up after three tries instead of looping
forever. Each attempt is announced in the terminal and counted in the sidebar,
so a crash loop is visible rather than merely noisy.

---

## Opening the browser

Turn on **Open in the browser once it answers** and Runner opens the project's
URL when it starts — but only once a port genuinely accepts a connection, not
when the process spawns. A browser pointed at a dev server two seconds before it
binds shows a connection error, and you are left refreshing a tab wondering
whether anything happened.

The port it opens is the first one the project announced in its own output,
falling back to the one Runner assigned. If nothing answers within ninety
seconds it says so and opens nothing.

---

## Settings

Every project is configured from a form, with a **Raw JSON** tab for when that
is quicker. Both are validated before anything is written to disk.

![The project settings form](docs/media/settings.gif)

Projects live in a single file at
`~/Library/Application Support/runner/projects.json`, seeded with an example on
first launch.

```json
{
  "projects": [
    {
      "id": "4369dbab-cb83-4fed-94ca-25be88fbf808",
      "name": "storefront",
      "path": "~/Projects/storefront",
      "runCommand": "npm run dev",
      "port": [3000, 3001, 3002],
      "autoOpen": true,
      "autoRestart": { "enabled": true },
      "env": { "NODE_ENV": "development" }
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | auto | Stable identifier; generated for you if missing. |
| `name` | yes | Shown in the sidebar. Must be unique. |
| `path` | yes | Project directory. `~` is expanded. |
| `runCommand` | yes | Passed to the shell, e.g. `npm run dev`. |
| `port` | no | Allowed ports, tried in order. Omit to not manage ports. |
| `dependsOn` | no | Ids of projects to start first, and wait for. |
| `readiness` | no | How dependents know this project is up. |
| `autoOpen` | no | Open in the browser once it answers. |
| `autoRestart` | no | `{ enabled, maxAttempts, delayMs }`, or `true` for the defaults. |
| `protocol` | no | `http` (default) or `https`, for the browser links. |
| `env` | no | Extra environment variables for the child process. |
| `shell` | no | Shell to run the command with. Defaults to your login shell. |
| `cwd` | no | Working directory override. Defaults to `path`. |

### Which shell your commands run in

Your **login shell**, from the passwd database — the one `chsh` sets — as a
login and interactive shell, so `nvm`/`fnm`/`asdf` shims resolve exactly as they
do when you type the command yourself.

Deliberately not `$SHELL`: launchd does not set it for apps opened from Finder
or the Dock, and anything that does launch Runner with one passes on its own
rather than yours. Picking the wrong shell gives the command a different `PATH`,
and possibly a different `node`, than the terminal you tested it in. Whichever
is being used is printed in the terminal header on every run.

### Shortcuts

| Key | Action |
| --- | --- |
| `⌘R` | Restart the selected project |
| `⌘.` | Stop the selected project |
| `⌘,` | Edit configuration |

---

## Installing

Download the `.dmg` from the [releases page](https://github.com/dzhiganov/runner/releases/latest). **Apple
Silicon only** (M1 or newer) — on an Intel Mac, build from source.

Drag `Runner.app` to `/Applications`, then clear the quarantine flag once:

```bash
xattr -cr /Applications/Runner.app
```

Skip that and macOS claims the app "is damaged". It is not. The build is ad-hoc
signed rather than notarised by Apple, and macOS refuses to launch a
non-notarised app that arrived from another machine until the quarantine
attribute is cleared. Right-click → Open does **not** work around this; the
`xattr` command does. Removing the warning for good would need a paid Apple
Developer ID and per-build notarisation.

---

## Running it yourself

```bash
npm install     # rebuilds node-pty against Electron automatically
npm run dev     # hot-reloading dev build
```

```bash
npm test          # process, port and config suite — spawns real processes
npm run typecheck
npm run build
npm run dist:dmg  # packaged .dmg in ./release
```

`npm test` binds ports 3000–3002, 3010–3017 and 3020–3023 while it runs.

---

## How it's built

Electron, React and TypeScript in strict mode, with `node-pty` for the terminals,
xterm.js for rendering them, and electron-vite for the build. One runtime
dependency — the icon set is inline SVG rather than a package.

```
src/
  main/                 Electron main process
    index.ts            window, IPC, quit handling
    process-manager.ts  PTY lifecycle: start/stop/restart, group kill, buffers
    orchestrator.ts     dependency trees: topological start, readiness, tree stop
    ports.ts            free-port detection, fallback, release waits, probes
    config.ts           read/write the JSON file
    config-validate.ts  pure validation and migration, no Electron import
  preload/index.ts      contextBridge API exposed to the renderer
  renderer/src/         sidebar, toolbar, terminal host, settings editor
  shared/               types, and the dependency graph all three layers agree on
```

The renderer never touches a PTY. It sends intents — start, stop, restart — and
receives runtime snapshots plus output, which keeps the process lifecycle in one
place instead of spread across the UI.

`config-validate.ts` deliberately imports nothing from Electron, so validation
and migration are unit-testable on their own. `test/e2e.ts` spawns real
processes against fixture dev servers and asserts against real ports: that a
restart survives the project still holding its own port, that a failing
dependency aborts a tree, that a stop reaches every child in the group.

---

## Licence

MIT. See [LICENSE](LICENSE).
