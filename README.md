# Runner

A macOS app for starting, restarting and stopping your local dev servers from one window.
Each project gets a real terminal, an auto-assigned port, and a one-click link to
`localhost`. Projects can depend on each other, so one click brings up a whole stack in
the right order.

Built with Electron + React + TypeScript. Every project runs in a real pseudo-terminal
(`node-pty`), so colors, spinners and progress bars behave exactly as they do in iTerm.

## Download

Grab the latest `.dmg` from the [releases page](../../releases/latest). **Apple Silicon
only** (M1 or newer) — on an Intel Mac, build from source instead.

The build is ad-hoc signed rather than notarised by Apple, so after dragging it to
`/Applications` you have to clear the quarantine flag once:

```bash
xattr -cr /Applications/Runner.app
```

Skip that and macOS claims the app "is damaged", which it is not — that is simply what it
says about a non-notarised app downloaded from the internet. Right-click → Open does not
work around it; the `xattr` command is the fix. Removing the warning for good would need a
paid Apple Developer ID and per-build notarisation.

## Getting started

```bash
npm install     # rebuilds node-pty against Electron automatically
npm run dev     # hot-reloading dev build
npm test        # process/port/config test suite (spawns real processes)
npm run dist:dmg # packaged .dmg in ./release
```

## Configuration

Projects live in a single JSON file at:

```
~/Library/Application Support/runner/projects.json
```

Edit it from the gear icon (⌘,) — there is a per-project form and a **Raw JSON** tab,
both validated before anything is written. The file is seeded with an example on first
launch.

```json
{
  "projects": [
    {
      "id": "4369dbab-cb83-4fed-94ca-25be88fbf808",
      "name": "my app",
      "path": "~/Documents/projects/my-app",
      "runCommand": "npm run dev",
      "port": [3000, 3001, 3002],
      "autoOpen": true,
      "autoRestart": { "enabled": true, "maxAttempts": 3, "delayMs": 1000 },
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
| `readiness` | no | How dependents know this project is up — see below. |
| `autoOpen` | no | Open the project in the browser once it answers — see below. |
| `autoRestart` | no | Bring the project back after a crash — see below. |
| `protocol` | no | `http` (default) or `https`, used by the ↗ browser links. |
| `env` | no | Extra environment variables for the child process. |
| `shell` | no | Shell to run the command with. Defaults to your login shell. |
| `cwd` | no | Working directory override. Defaults to `path`. |

## How ports work

`port` is the list of ports a project is allowed to use. Runner walks it in order,
takes the first free one, and exports it to the child as `PORT` — which Next.js, Vite,
CRA, Express and Nest all pick up without extra configuration.

The list is authoritative. If every entry is taken, Runner does **not** invent a port
outside it: the Run button is disabled and hovering it says which ports are occupied.
Availability is re-checked every few seconds while a project is stopped, so the button
re-enables on its own once something frees up.

A port counts as busy if anything accepts a TCP connection on it (`127.0.0.1` or `::1`)
or if the wildcard address cannot be bound. Both checks are needed: Node sets
`SO_REUSEADDR`, so a bind probe alone reports a port as free while another dev server is
listening on it.

## Ports Runner did not assign

`PORT` only describes one server. Commands that start several at once — an Nx
`run-many`, a monorepo dev script — ignore it, and so do tools that hard-code their port.
For those, Runner reads the ports out of the child's own output: any
`http://localhost:4200/` it prints becomes a ↗ link in the toolbar and the sidebar.
Detected ports always win over the assigned one, because they are what is actually
listening.

If your tool ignores `PORT` and you want to control it, reference the resolved value in
the command instead — for example `npm run dev -- --port $PORT`.

## Opening the browser automatically

`"autoOpen": true` opens the project's URL once it is up — the equivalent of watching
the log for `localhost:3000` and clicking the link yourself.

The wait is the interesting part. Runner does not open the URL when the process spawns;
it waits until a port actually accepts a connection, then opens that. A browser pointed
at a dev server two seconds before it binds shows a connection error, and you are left
refreshing a tab wondering whether anything happened.

Which port is used follows the same rule as the ↗ links: the first port the project
announced in its own output, falling back to the one Runner assigned via `PORT`. The
scheme comes from `protocol`. If nothing answers within 90s, Runner says so in the
terminal and opens nothing.

## Restarting after a crash

```json
"autoRestart": { "enabled": true, "maxAttempts": 3, "delayMs": 1000 }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Whether to restart at all. `"autoRestart": true` is shorthand for enabling it with the defaults. |
| `maxAttempts` | `3` | Consecutive retries before Runner gives up. |
| `delayMs` | `1000` | Wait before the first retry. Doubles each attempt, capped at 30s. |

Only **unexpected** exits count. A Stop you asked for, a Restart, and a clean `exit 0`
are all taken at their word — nothing comes back. A non-zero exit or a kill signal is a
crash.

Attempts are *consecutive*. A run that stays up for 20 seconds is treated as healthy and
resets the budget, so a project that crashes once a day is restarted every time, while
one that cannot start at all is given up on after three tries rather than looping
forever. Each attempt is announced in the terminal, and the sidebar shows `retry 2`
under the project's name so a crash loop is visible rather than merely noisy.

## Dependencies between projects

`dependsOn` lists the ids of projects that must be up first. Run on a project starts the
whole tree, deepest first, and the sidebar shows it as a tree — a project's dependencies
nested underneath it, foldable.

```json
{ "id": "web", "name": "storefront", "dependsOn": ["api"], "…": "…" },
{ "id": "api", "name": "api", "dependsOn": ["db"], "…": "…" },
{ "id": "db",  "name": "postgres", "…": "…" }
```

Running `storefront` starts `postgres`, waits for it, starts `api`, waits for it, then
starts `storefront`. Waiting is the point: a frontend that boots while its backend is
still binding a port fails in ways that look nothing like the real problem.

**How "ready" is decided**, most specific first:

1. `readiness.logPattern` — a regular expression matched against the project's output.
2. `readiness.port` — wait until that TCP port accepts a connection.
3. Otherwise the port Runner assigned via `PORT`.
4. With nothing to probe, the project is ready once it has survived its first moment.

`readiness.timeoutMs` (default 90s) caps the wait. A timeout is a warning, not a failure:
the dependency is up, Runner just could not prove it is serving, so the dependent starts
anyway. A dependency that genuinely *fails* aborts the tree and every project in it says
which dependency broke.

Stop on a project stops its dependencies too — except any that another still-running
project needs. **Run alone** and **Stop only** in the toolbar skip the tree entirely, for
when the dependencies are already running somewhere else.

Cycles are rejected at save time, naming the loop (`storefront → api → storefront`), and
the editor disables the checkbox that would create one.

## Behaviour

- **Run / Restart / Stop** per project, from the sidebar or the toolbar. Run brings up
  the project's dependency tree; Restart only restarts the project itself.
- **Restart stops first, and waits.** A dev server keeps its listening socket for a
  moment after the shell Runner spawned it through is gone, so restarting immediately
  would hit the project's own leftover listener and report every port as busy. Runner
  waits (up to 8s) for the ports to actually come back before starting again.
- **A tree in the sidebar**, dependencies nested and foldable under the project that
  needs them. A spinner sits next to the name while a project is waiting on a dependency,
  starting or stopping, and a warning triangle when it has crashed or failed to start.
- **Open in browser**: a ↗ next to each running project in the sidebar, and one button
  per detected port in the toolbar. Scheme follows the project's `protocol`.
- **Drag projects in the sidebar** to reorder them; the new order is saved immediately.
- **Run is disabled** when every allowed port is taken, with the reason on hover.
- Stopping sends `SIGTERM` to the child's whole **process group**, escalating to
  `SIGKILL` after 4s — so `npm run dev` takes vite/tsc/nodemon down with it instead of
  orphaning them on the port.
- Quitting the app asks for confirmation if anything is running, then shuts everything
  down. No stray dev servers.
- Terminals are interactive: keystrokes, `Ctrl-C` and prompts reach the child process.
  Scrollback survives switching between projects.
- Commands run through a **login + interactive shell**, so `nvm`/`fnm`/`asdf` shims
  resolve the same way they do when you run the command by hand.
- The shell is your **login shell** from the passwd database, not `$SHELL` — launchd does
  not set `$SHELL` for apps opened from Finder or the Dock, and falling back to a shell
  you do not use gives the command a different `PATH`, and possibly a different `node`,
  than the terminal you tested it in.

### Shortcuts

| Key | Action |
| --- | --- |
| `⌘R` | Restart the selected project |
| `⌘.` | Stop the selected project |
| `⌘,` | Edit configuration |

## Project layout

```
src/
  main/                 Electron main process
    index.ts            window, IPC, quit handling
    process-manager.ts  PTY lifecycle: start/stop/restart, group kill, output buffers
    orchestrator.ts     dependency trees: topological start, readiness, tree stop
    ports.ts            free-port detection, fallback, release waits, readiness probes
    config.ts           read/write the JSON file
    config-validate.ts  pure validation and config migration (no Electron import,
                        so it is unit-testable)
    paths.ts            `~` expansion
  preload/index.ts      contextBridge API exposed to the renderer
  renderer/src/
    App.tsx             sidebar, toolbar, status bar
    components/
      TerminalHost.tsx  one long-lived xterm instance per project
      ConfigEditor.tsx  form + raw JSON editor
      Icons.tsx         inline SVG icon set
  shared/
    types.ts            types shared across all three layers
    graph.ts            dependency graph: cycles, start order, sidebar tree
test/e2e.ts             spawns real processes against a fixture dev server
```

## Licence

MIT — see [LICENSE](LICENSE).

## Notes

- The packaged build is unsigned (`identity: null` in `electron-builder.yml`). macOS will
  quarantine it on first open; right-click → Open, or add a signing identity.
- `npm test` binds ports 3000–3002, 3010–3017 and 3020–3023 while it runs.
- Runner used to have a separate Docker project type. It does not any more — a Docker
  stack is just a command like any other. Projects saved by an older version are migrated
  on load into the `docker compose up` command they were already running, which is now
  visible and editable in the form like every other command.
