# Runner — install on macOS

Run and manage several local dev servers from one window. Each project gets a real
terminal, an auto-assigned port, and a link that opens it in your browser. Projects can
depend on each other, so one click brings up a whole stack in the right order.

**This build is for Apple Silicon** (M1 or newer). It will not launch on an Intel Mac —
rebuild from source there instead.

---

## Install

**1.** Drag `Runner.app` into `/Applications`.

**2.** Clear the quarantine flag. Open Terminal and run:

```bash
xattr -cr /Applications/Runner.app
```

**3.** Open Runner from Applications, Spotlight, or Launchpad.

### Step 2 is not optional

Skip it and macOS says **"Runner is damaged and can't be opened. You should move it to the
Bin."** That message is misleading — nothing is damaged. The app is ad-hoc signed rather
than notarised by Apple, and macOS refuses to launch a non-notarised app that arrived from
another machine until the quarantine attribute is removed.

The usual right-click → Open trick does **not** work for this case. You need the `xattr`
command.

Getting rid of the warning permanently would require an Apple Developer ID certificate
(a paid Apple Developer account) and notarising each build.

---

## First run

Runner writes a config file with one example project the first time it starts:

```
~/Library/Application Support/Runner/projects.json
```

Click the **⚙** icon (or press `⌘,`) to edit it. There is a form per project and a **Raw
JSON** tab; both are validated before anything is written to disk.

### Project fields

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Shown in the sidebar. Must be unique. |
| `path` | yes | Project directory. `~` is expanded. |
| `runCommand` | yes | Passed to the shell, e.g. `npm run dev`. |
| `port` | no | Ports the project may use, tried in order. Omit to not manage ports. |
| `dependsOn` | no | Ids of projects to start first, and wait for. |
| `readiness` | no | How dependents know this project is up — see below. |
| `autoOpen` | no | Open the project in your browser once it answers — see below. |
| `autoRestart` | no | Bring the project back after a crash — see below. |
| `protocol` | no | `http` (default) or `https`, used by the ↗ browser links. |
| `env` | no | Extra environment variables for the child process. |
| `shell` | no | Shell to run the command with. Defaults to your login shell. |
| `cwd` | no | Working directory override. Defaults to `path`. |

Example:

```json
{
  "projects": [
    {
      "id": "4369dbab-cb83-4fed-94ca-25be88fbf808",
      "name": "storefront",
      "path": "~/Documents/projects/storefront",
      "runCommand": "npm run dev",
      "port": [3000, 3001, 3002],
      "autoOpen": true,
      "autoRestart": { "enabled": true },
      "env": { "NODE_ENV": "development" }
    }
  ]
}
```

---

## Opening the browser automatically

Tick **Open in the browser once it answers** in the editor (or `"autoOpen": true`) and
Runner opens the project's URL for you when it starts.

It waits until a port actually accepts a connection before opening, rather than opening
the moment the process starts. A browser pointed at a dev server two seconds before it
binds shows a connection error, and you are left refreshing a tab wondering whether
anything happened.

The port used is the first one the project announced in its own output, falling back to
the one Runner assigned as `PORT`. The scheme follows `protocol`. If nothing answers
within 90 seconds, Runner says so in the terminal and opens nothing.

## Restarting after a crash

Tick **Restart automatically** under *On crash*, or in JSON:

```json
"autoRestart": { "enabled": true, "maxAttempts": 3, "delayMs": 1000 }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Whether to restart at all. `"autoRestart": true` also works. |
| `maxAttempts` | `3` | Consecutive retries before Runner gives up. |
| `delayMs` | `1000` | Wait before the first retry. Doubles each attempt, capped at 30s. |

Only **unexpected** exits count. A Stop you asked for, a Restart, and a clean exit are
taken at their word — nothing comes back. A non-zero exit or a kill signal is a crash.

Attempts are consecutive: a run that stays up for 20 seconds counts as healthy and resets
the budget. So a project that crashes once a day is restarted every time, while one that
cannot start at all is given up on after three tries instead of looping forever. Each
attempt is announced in the terminal, and the sidebar shows `retry 2` under the name so a
crash loop is visible rather than merely noisy.

## Projects that depend on other projects

`dependsOn` lists the ids of projects that must be up first. Run starts the whole tree,
deepest first, and the sidebar shows it as a folder tree you can fold.

```json
{ "id": "web", "name": "storefront", "dependsOn": ["api"], "…": "…" },
{ "id": "api", "name": "api",        "dependsOn": ["db"],  "…": "…" },
{ "id": "db",  "name": "postgres",                         "…": "…" }
```

Running `storefront` starts `postgres`, **waits for it**, starts `api`, waits for it, then
starts `storefront`. The waiting is the point: a frontend that boots while its backend is
still binding a port fails in ways that look nothing like the real problem.

How "ready" is decided, most specific first:

1. `readiness.logPattern` — a regular expression matched against the project's output.
2. `readiness.port` — wait until that TCP port accepts a connection.
3. Otherwise the port Runner assigned as `PORT`.
4. With nothing to probe, ready once it survives its first moment.

`readiness.timeoutMs` (default 90s) caps the wait. A timeout only warns and carries on. A
dependency that genuinely **fails** aborts the tree, and every project in it tells you
which dependency broke.

Stop takes the tree down too — except any dependency another running project still needs.
**Run alone** and **Stop only** in the toolbar skip the tree, for when the dependencies
are already up elsewhere.

Cycles are refused when you save, naming the loop.

---

## Using it

- **Run / Restart / Stop** from the sidebar or the toolbar. `⌘R` restarts, `⌘.` stops.
  Run brings up the dependency tree; Restart only restarts that one project.
- **Restart stops first and waits for the ports.** A dev server holds its port for a
  moment after it is asked to stop, so Runner waits for it to be released before starting
  again rather than colliding with the project's own leftover listener.
- **A spinner next to the name** while a project is waiting on a dependency, starting or
  stopping; a **warning triangle** when it crashed or failed to start.
- **Drag projects** in the sidebar to reorder them. The order saves immediately. Nested
  dependencies keep the position their parent gives them.
- **↗ links** open the project in your default browser — one next to each running project,
  and one per port in the toolbar.
- Terminals are interactive: keystrokes, `Ctrl-C` and prompts reach the process. Scrollback
  survives switching between projects.
- Quitting Runner asks for confirmation if anything is running, then shuts it all down.
  Stopping kills the whole process group, so `npm run dev` takes vite/tsc down with it
  instead of orphaning them on a port.

### How ports work

`port` is the list of ports a project is allowed to use. Runner takes the first free one
and passes it to the process as `PORT`, which Next.js, Vite, CRA, Express and Nest all
respect without extra configuration.

The list is authoritative. If every port in it is taken, **Run is disabled** and hovering
it tells you which ports are occupied. Runner re-checks every few seconds, so the button
re-enables on its own once one frees up.

Commands that start several servers at once — an Nx `run-many`, a monorepo dev script —
ignore `PORT` entirely. For those, Runner **reads the ports out of the command's own
output**: any `http://localhost:4200/` it prints becomes a ↗ link. Detected ports always
win over the assigned one, because they are what is actually listening.

### Which shell your commands run in

Runner uses **your login shell** (from the passwd database — the same one `chsh` sets), as
a login + interactive shell, so `nvm`/`fnm`/`asdf` shims resolve exactly as they do when
you type the command yourself.

The shell is printed in the terminal header on every run:

```
$ npm run dev
  in /Users/you/projects/storefront · PORT=3000 · /bin/zsh
```

Override it per project with the `shell` field if a command needs a different one — for
example `"shell": "/bin/zsh"` for a command using POSIX syntax like `VAR=value cmd`, which
fish does not support.

---

## Troubleshooting

**"Runner is damaged and can't be opened"** — the `xattr -cr` step above was skipped.

**`command not found: <tool>`** — the tool is a local dependency, not a global one. Use
`npx <tool> …`, or the package script that wraps it.

**Wrong Node version / a tool crashes here but works in your terminal** — check the shell
in the terminal header. If it is not the shell you normally use, your terminal app may be
set to a different one than your login shell; set `shell` on the project to match.

**A port link opens nothing** — the app is probably serving on a port it never printed and
that Runner did not assign. Add it to the project's `port` list, or check the terminal
output for the real address.

**A project keeps restarting itself** — auto-restart is on and the command is failing on
startup. Runner stops after `maxAttempts` and says so in the terminal; the output above
that message is the actual error.

**Upgrading from an older Runner?** Docker used to be a separate project type. It is not
any more — a Docker stack is just a command. Your existing Docker projects are converted
on first launch into the `docker compose up …` command they were already running, which
you can now see and edit in the form like every other command.

**A dependency "did not report ready in time"** — Runner started the dependent anyway. If
the dependency does not bind a TCP port, give it a `readiness.logPattern` so Runner knows
what "up" looks like for it.

---

## Moving your project list between Macs

Copy `~/Library/Application Support/Runner/projects.json`. The `path` entries have to
exist on the target machine, and that machine's shell needs whatever toolchain those
commands require.

`dependsOn` refers to project **ids**, which travel inside the same file, so dependency
trees survive the copy intact.

## Uninstall

```bash
rm -rf /Applications/Runner.app
rm -rf ~/Library/Application\ Support/Runner
```
