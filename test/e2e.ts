import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { ProcessManager, defaultShell } from '../src/main/process-manager.js'
import { Orchestrator } from '../src/main/orchestrator.js'
import { resolvePort, isPortFree, waitForPort, waitForPortsFree } from '../src/main/ports.js'
import { migrate, validateConfig } from '../src/main/config-validate.js'
import { fallbackCommand, inspect, scan, tildify } from '../src/main/discovery.js'
import { LogStore, levelOf } from '../src/main/log-store.js'
import { whoHolds, groupIsSafeToKill } from '../src/main/port-owner.js'
import { classify, killOwner, projectAt } from '../src/main/port-conflict.js'
import { parseWorktrees, repoInfo, forgetRepos } from '../src/main/git.js'
import { parseListeners, sweep } from '../src/main/processes.js'
import { buildTree, dependentsOf, findCycles, startOrder } from '../src/shared/graph.js'
import type { ProjectConfig, ProjectRuntime } from '../src/shared/types.js'

/** Run from the repo root via `npm test`. */
const APP = join(process.cwd(), 'test', 'fixtures', 'fake-app')
const LINGERING = join(process.cwd(), 'test', 'fixtures', 'lingering-app')
const results: string[] = []
let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function waitFor(fn: () => boolean | Promise<boolean>, ms = 15000): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = async (): Promise<void> => {
      if (await fn()) return resolve(true)
      if (Date.now() - start > ms) return resolve(false)
      setTimeout(tick, 100)
    }
    void tick()
  })
}

async function main(): Promise<void> {
  // --- config validation -------------------------------------------------
  const bad = validateConfig({ projects: [{ name: '', path: '', runCommand: '', port: [0] }] })
  check('validation rejects an empty project', !bad.ok && bad.issues.length >= 4)

  const good = validateConfig({
    projects: [{ name: 'a', path: '~/x', runCommand: 'npm run dev', port: [3000, 3000, 3001] }]
  })
  check(
    'validation dedupes ports and assigns an id',
    good.ok && good.config.projects[0].port!.join(',') === '3000,3001' && !!good.config.projects[0].id
  )

  const dupes = validateConfig({
    projects: [
      { name: 'a', path: '~/x', runCommand: 'c' },
      { name: 'a', path: '~/y', runCommand: 'c' }
    ]
  })
  check('validation rejects duplicate names', !dupes.ok)

  // --- project discovery -------------------------------------------------
  // The tree is built here rather than committed: a fixture containing `.git`
  // directories would be an embedded repository in Runner's own checkout.
  const ROOT = join(tmpdir(), `runner-discovery-${process.pid}`)
  const make = (relative: string, files: Record<string, string> = {}, dirs: string[] = []): void => {
    const dir = join(ROOT, relative)
    mkdirSync(dir, { recursive: true })
    for (const name of dirs) mkdirSync(join(dir, name), { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  }

  rmSync(ROOT, { recursive: true, force: true })
  make('plain-npm', {
    'package.json': '{"name":"storefront","scripts":{"build":"tsc","dev":"vite","test":"t"}}',
    'package-lock.json': '{}'
  }, ['.git'])
  make('plain-npm/node_modules/evil', {
    'package.json': '{"name":"evil","scripts":{"dev":"x"}}'
  })
  make('pnpm-app', {
    'package.json': '{"name":"my-api","scripts":{"start":"node .","test":"jest"}}',
    'pnpm-lock.yaml': 'lockfileVersion: 6'
  })
  make('yarn-app', {
    'package.json': '{"name":"toolbox","scripts":{"build":"tsc","lint":"eslint ."}}',
    'yarn.lock': '# yarn'
  })
  make('bun-app', {
    'package.json': '{"name":"bun-thing","scripts":{"dev":"bun run index.ts"}}',
    'bun.lockb': 'x'
  })
  // A linked worktree: `.git` is a file, not a directory.
  make('worktree-checkout', {
    '.git': 'gitdir: /somewhere/.git/worktrees/feat\n',
    'package.json': '{"name":"feature-branch","scripts":{"dev":"vite"}}',
    'package-lock.json': '{}'
  })
  make('git-only', {}, ['.git'])
  make('nested/deep-app', {
    'package.json': '{"name":"deep","scripts":{"dev":"vite"}}',
    'package-lock.json': '{}'
  })
  make('not-a-project', { 'readme.txt': 'notes' })
  make('monorepo', {
    'package.json': '{"name":"monorepo","scripts":{"dev":"turbo dev"}}',
    'pnpm-lock.yaml': 'lockfileVersion: 6'
  }, ['.git'])
  make('monorepo/packages/a', { 'package.json': '{"name":"pkg-a"}' })
  make('monorepo/packages/b', { 'package.json': '{"name":"pkg-b"}' })
  make('broken-json', { 'package.json': '{ this is not json' }, ['.git'])

  const found = scan([ROOT])
  const byName = (name: string): (typeof found)[number] | undefined =>
    found.find((p) => p.name === name)

  check(
    'scan finds every project directory under the root',
    found.length === 9,
    `found ${found.length}: ${found.map((p) => p.name).join(', ')}`
  )
  check('scan skips a directory that is neither git nor node', !byName('not-a-project'))

  // Regression: `.git` is a FILE in a linked worktree. Testing isDirectory()
  // here would silently skip every worktree checkout on the machine.
  check('scan detects a worktree checkout, where .git is a file', !!byName('feature-branch'))

  check('scan descends two levels', !!byName('deep'))
  check(
    'scan does not walk into node_modules',
    !byName('evil'),
    'a dependency must never be offered as a project'
  )
  check(
    'scan stops at a project boundary rather than listing its packages',
    !!byName('monorepo') && !byName('pkg-a') && !byName('pkg-b')
  )
  check(
    'scan uses the directory name when package.json will not parse',
    byName('broken-json')?.hasPackageJson === true
  )
  check('scan prefers the package.json name over the folder name', !!byName('storefront'))

  check('lockfile identifies pnpm', byName('my-api')?.packageManager === 'pnpm')
  check('lockfile identifies yarn', byName('toolbox')?.packageManager === 'yarn')
  check('lockfile identifies bun', byName('bun-thing')?.packageManager === 'bun')
  check('lockfile identifies npm', byName('storefront')?.packageManager === 'npm')
  // A package.json with no lockfile at all: nothing to prefix a script with,
  // so no commands are offered rather than guessing npm and being wrong.
  // Built outside ROOT so it does not shift the scan counts asserted above.
  const LOCKLESS = join(tmpdir(), `runner-lockless-${process.pid}`)
  mkdirSync(LOCKLESS, { recursive: true })
  writeFileSync(
    join(LOCKLESS, 'package.json'),
    '{"name":"lockless","scripts":{"dev":"vite"}}'
  )
  const lockless = inspect(LOCKLESS)
  rmSync(LOCKLESS, { recursive: true, force: true })
  check(
    'a project with no lockfile offers no package manager and no commands',
    lockless?.packageManager === null &&
      lockless?.commands.length === 0 &&
      lockless?.suggestedCommand === null
  )

  check(
    'npm scripts are spelled with `run`, other managers without it',
    byName('storefront')?.suggestedCommand === 'npm run dev' &&
      byName('bun-thing')?.suggestedCommand === 'bun dev'
  )
  check(
    'a project with `start` but no `dev` suggests start',
    byName('my-api')?.suggestedCommand === 'pnpm start'
  )
  check(
    'a project whose scripts all exit suggests nothing',
    byName('toolbox')?.suggestedCommand === null,
    `got ${byName('toolbox')?.suggestedCommand}`
  )
  check(
    'a git repo with no package.json suggests nothing and lists no commands',
    byName('git-only')?.suggestedCommand === null && byName('git-only')?.commands.length === 0
  )
  check(
    'every script is listed even when it is not the suggestion',
    byName('storefront')?.commands.sort().join(',') === 'npm run build,npm run dev,npm run test'
  )

  // Validation requires a runCommand, so a project with nothing to suggest
  // still needs one to be addable at all.
  check('fallback command follows the detected manager', fallbackCommand('pnpm') === 'pnpm dev')
  check('fallback command assumes npm when nothing was detected', fallbackCommand(null) === 'npm run dev')

  const already = scan([ROOT], [join(ROOT, 'plain-npm'), join(ROOT, 'monorepo')])
  check(
    'a re-scan omits projects already in the config',
    already.length === found.length - 2 && !already.some((p) => p.name === 'storefront')
  )

  check('scan ignores a root that does not exist', scan([join(ROOT, 'nope')]).length === 0)
  check('scan ignores a root that is a file', scan([join(ROOT, 'not-a-project/readme.txt')]).length === 0)
  check(
    'the same project under two overlapping roots is listed once',
    scan([ROOT, join(ROOT, 'plain-npm')]).filter((p) => p.name === 'storefront').length === 1
  )

  check('inspect returns null for a directory that is not a project', inspect(join(ROOT, 'not-a-project')) === null)
  check(
    'a discovered project carries both an absolute path and a display path',
    byName('storefront')?.path === join(ROOT, 'plain-npm') &&
      byName('storefront')?.displayPath === tildify(join(ROOT, 'plain-npm'))
  )

  const home = process.env.HOME ?? ''
  check(
    'paths are written back in ~ form so the config stays portable',
    tildify(join(home, 'Projects/api')) === '~/Projects/api' && tildify('/opt/x') === '/opt/x'
  )
  check(
    'tildify does not mangle a sibling of the home directory',
    tildify(`${home}-backup/api`) === `${home}-backup/api`
  )

  // A discovered project must survive the validator it will be handed to.
  const discovered = validateConfig({
    projects: [
      { name: byName('storefront')!.name, path: tildify(byName('storefront')!.path), runCommand: byName('storefront')!.suggestedCommand }
    ]
  })
  check('a discovered project passes config validation', discovered.ok)

  const withRoots = validateConfig({ projects: [], scanRoots: ['~/Projects', '~/Projects', ' ~/Work '] })
  check(
    'scanRoots are preserved, trimmed and deduped',
    withRoots.ok && withRoots.config.scanRoots?.join(',') === '~/Projects,~/Work'
  )
  const badRoots = validateConfig({ projects: [], scanRoots: 'nope' })
  check('scanRoots must be an array', !badRoots.ok)

  rmSync(ROOT, { recursive: true, force: true })

  // --- merged logs -------------------------------------------------------
  const store = new LogStore()

  // A chunk boundary lands wherever the OS felt like it. A line split across
  // two reads must be stored as one, or it is searched and filtered as two.
  store.ingest('a', 'first line\nsecond ')
  store.ingest('a', 'half of a line\n')
  const split = store.query()
  check(
    'a line split across two chunks is stored once',
    split.length === 2 && split[1].text === 'second half of a line',
    split.map((l) => l.text).join(' | ')
  )

  check('lines are ordered oldest first', split[0].text === 'first line')
  check('sequence numbers increase', split[0].seq < split[1].seq)

  // An unterminated tail is held back until the newline arrives, so a partial
  // line is never shown as if it were complete.
  store.ingest('a', 'no newline yet')
  check('an unterminated line is withheld', store.query().length === 2)
  store.flush('a')
  check('flush files what a process left unterminated', store.query().length === 3)
  store.flush('a')
  check('flushing twice does not duplicate the line', store.query().length === 3)

  store.clear()

  // Regression: a PTY ends its lines with CRLF, not LF. Treating the line's own
  // terminating CR as a progress-bar rewrite takes everything after it — the
  // empty string — and silently drops every line the app ever prints.
  store.ingest('a', 'api booting\r\nready on http://localhost:3000\r\n')
  const crlf = store.query()
  check(
    'CRLF line endings are handled, not swallowed',
    crlf.length === 2 && crlf[0].text === 'api booting',
    `${crlf.length} lines: ${crlf.map((l) => JSON.stringify(l.text)).join(' | ')}`
  )

  store.clear()

  // A progress bar rewrites one line with carriage returns; the terminal shows
  // only the last frame, so keeping every frame would fill the log with one
  // download.
  store.ingest('a', 'downloading 1%\rdownloading 50%\rdownloading 100%\n')
  const progress = store.query()
  check(
    'carriage returns collapse to the final frame',
    progress.length === 1 && progress[0].text === 'downloading 100%',
    progress.map((l) => l.text).join(' | ')
  )

  store.clear()
  store.ingest('a', '\x1b[32mready on http://localhost:3000\x1b[0m\n')
  check(
    'ANSI escapes are stripped from the stored text',
    store.query()[0].text === 'ready on http://localhost:3000',
    JSON.stringify(store.query()[0].text)
  )

  // Colour is read before the escapes are stripped, and trusted over the text:
  // a server that paints a line red has said so more directly than any pattern.
  check('a red line is an error', levelOf('\x1b[31msomething broke\x1b[0m') === 'error')
  check('a bright red line is an error', levelOf('\x1b[1;91mbroke\x1b[0m') === 'error')
  check('a yellow line is a warning', levelOf('\x1b[33mheads up\x1b[0m') === 'warn')
  check('an uncoloured line is info', levelOf('GET /products 200') === 'info')

  check('ERROR in the text marks an error', levelOf('ERROR database connection') === 'error')
  check('npm ERR! marks an error', levelOf('npm ERR! code ELIFECYCLE') === 'error')
  check('WARN in the text marks a warning', levelOf('WARN peer dependency') === 'warn')

  // Regression: `error` appears inside ordinary identifiers and in perfectly
  // happy build output. Matching it loosely would make the filter useless.
  check('a filename containing "error" is not an error', levelOf('compiled src/errorHandler.ts') === 'info')
  check('"no errors" is not an error', levelOf('webpack compiled with no errors') === 'info')

  store.clear()
  store.ingest('api', 'GET /products\nERROR db is down\nWARN slow query\n')
  store.ingest('web', 'compiled ok\nERROR build failed\n')

  check('query returns every project by default', store.query().length === 5)
  check(
    'query filters by project',
    store.query({ projectIds: ['api'] }).length === 3
  )
  check(
    'query filters by level',
    store.query({ levels: ['error'] }).length === 2
  )
  check(
    'query filters by project and level together',
    store.query({ projectIds: ['web'], levels: ['error'] }).length === 1
  )
  check(
    'search is a case-insensitive substring match',
    store.query({ search: 'DB IS' }).length === 1 &&
      store.query({ search: 'db is' })[0].text === 'ERROR db is down'
  )
  check(
    'search combines with the other filters',
    store.query({ search: 'error', projectIds: ['web'] }).length === 1
  )
  check('an unmatched search returns nothing', store.query({ search: 'zzzz' }).length === 0)

  // The limit must keep the NEWEST lines: a log view showing the oldest 50 of
  // 5000 is showing the wrong end of the file.
  const limited = store.query({ limit: 2 })
  check(
    'a limit keeps the newest lines, still oldest-first',
    limited.length === 2 &&
      limited[1].text === 'ERROR build failed' &&
      limited[0].seq < limited[1].seq,
    limited.map((l) => l.text).join(' | ')
  )

  check('clearing one project leaves the others', (() => {
    const s2 = new LogStore()
    s2.ingest('api', 'one\n')
    s2.ingest('web', 'two\n')
    s2.clear('api')
    const rest = s2.query()
    return rest.length === 1 && rest[0].projectId === 'web'
  })())

  check('pruning drops projects that no longer exist', (() => {
    const s2 = new LogStore()
    s2.ingest('api', 'one\n')
    s2.ingest('gone', 'two\n')
    s2.prune(new Set(['api']))
    return s2.query().length === 1 && s2.query()[0].projectId === 'api'
  })())

  check('blank lines are not stored', (() => {
    const s2 = new LogStore()
    s2.ingest('a', 'real\n\n   \n\x1b[0m\n')
    return s2.query().length === 1
  })())

  check('a live line is emitted as it arrives', (() => {
    const s2 = new LogStore()
    const seen: string[] = []
    s2.on('line', (line) => seen.push(line.text))
    s2.ingest('a', 'streamed\n')
    return seen.length === 1 && seen[0] === 'streamed'
  })())

  // Retention: a dev server left up all day must not grow this without limit.
  const big = new LogStore()
  for (let i = 0; i < 25_000; i += 1) big.ingest('a', `line ${i}\n`)
  const kept = big.query({ limit: 100_000 })
  check(
    'the store is bounded and keeps the newest lines',
    big.size() <= 20_000 && kept[kept.length - 1].text === 'line 24999',
    `held ${big.size()}`
  )

  // --- worktrees ---------------------------------------------------------
  const PORCELAIN = [
    'worktree /repos/app',
    'HEAD 4d759327784a1b07d5c34da4f4eb0ad8c89c9532',
    'branch refs/heads/main',
    '',
    'worktree /repos/app-detached',
    'HEAD 4d759327784a1b07d5c34da4f4eb0ad8c89c9532',
    'detached',
    '',
    'worktree /repos/app-feat',
    'HEAD 4d759327784a1b07d5c34da4f4eb0ad8c89c9532',
    'branch refs/heads/feat/GC-123',
    'locked',
    ''
  ].join('\n')

  const parsed = parseWorktrees(PORCELAIN)
  check('every worktree record is parsed', parsed.length === 3, `${parsed.length}`)
  check('the main worktree comes first, as git lists it', parsed[0].path === '/repos/app')
  check('refs/heads/ is stripped from the branch', parsed[0].branch === 'main')
  check(
    'a branch containing a slash survives stripping',
    parsed[2].branch === 'feat/GC-123',
    `${parsed[2].branch}`
  )
  check('a detached worktree has no branch', parsed[1].branch === null && parsed[1].detached)
  check('a locked worktree is flagged', parsed[2].locked && !parsed[0].locked)
  check('the head commit is captured', parsed[0].head?.startsWith('4d7593') === true)

  // A bare repository has no working copy to run anything in.
  check(
    'a bare repository is not offered as a worktree',
    parseWorktrees('worktree /repos/bare\nHEAD abc\nbare\n').length === 0
  )
  check('empty output parses to nothing', parseWorktrees('').length === 0)
  check(
    'a trailing record with no blank line after it is still parsed',
    parseWorktrees('worktree /repos/x\nHEAD abc\nbranch refs/heads/y').length === 1
  )

  // Against a real repository — this one, which is always a git checkout when
  // the suite runs from the repo root.
  forgetRepos()
  const self = await repoInfo(process.cwd())
  check('repoInfo finds the repository it is run in', self !== null)
  check(
    'the repository is identified by its common git directory',
    self?.commonDir.endsWith('/.git') === true,
    `${self?.commonDir}`
  )
  check('the repository is named after its main working copy', self?.name === 'runner', `${self?.name}`)
  check(
    'the current directory is among the repository worktrees',
    self?.worktrees.some((w) => w.path === process.cwd()) === true
  )
  check('repoInfo returns null outside a repository', (await repoInfo('/tmp')) === null)

  // The cache must not leak between repositories: two directories, two answers.
  const cachedSelf = await repoInfo(process.cwd())
  check('a repeated read is served from cache with the same answer', cachedSelf?.name === self?.name)
  check('a different directory is not served the first one\'s answer', (await repoInfo('/tmp')) === null)

  // --- external processes ------------------------------------------------
  const LSOF = [
    'p400',
    'cnode',
    'f10',
    'n*:3000',
    'f11',
    'n127.0.0.1:3001',
    'p401',
    'cranger',
    'f12',
    'n[::1]:8080',
    'p402',
    'claunchd',
    'f13',
    'n*:22',
    'p403',
    'cnothing',
    'f14'
  ].join('\n')

  const listeners = parseListeners(LSOF)
  check('a process listening on several ports is one entry', listeners.length === 2, `${listeners.length}`)
  check(
    'every port of a process is collected',
    listeners.find((l) => l.pid === 400)?.ports.size === 2
  )
  check(
    'an IPv6 bracketed address parses',
    listeners.find((l) => l.pid === 401)?.ports.has(8080) === true
  )
  // Port 22 is sshd, not somebody's dev server.
  check('privileged ports are ignored', !listeners.some((l) => l.pid === 402))
  check('a process with no listening socket is dropped', !listeners.some((l) => l.pid === 403))
  check('empty output parses to nothing', parseListeners('').length === 0)

  // Against the machine, with a real listener inside this very project — which
  // is a configured project for the purposes of the sweep.
  const outside = createServer(() => {})
  await new Promise<void>((resolve) => outside.listen(4721, '127.0.0.1', resolve))

  const sweepProjects: ProjectConfig[] = [
    { id: 'self', name: 'self', path: process.cwd(), runCommand: 'x' }
  ]

  const external = await sweep(sweepProjects, () => false)
  const mine = external.find((p) => p.pid === process.pid)
  check('the sweep finds a listener inside a configured project', !!mine, `${external.length} found`)
  check('the sweep reports the port', mine?.ports.includes(4721) === true, `${mine?.ports}`)
  check('the sweep attributes it to the project', mine?.projectId === 'self')
  check('the sweep reports a full command line', (mine?.command.length ?? 0) > 10, mine?.command)

  // Runner's own processes are not external. Ownership is decided per project,
  // because the pid on the port is a grandchild of the shell Runner spawned
  // and was never a pid Runner recorded.
  const runnerOwned = await sweep(sweepProjects, (id) => id === 'self')
  check('a project Runner is running reports no external process', runnerOwned.length === 0)

  // Anything outside every configured project is somebody else's business.
  const elsewhere = await sweep(
    [{ id: 'x', name: 'x', path: '/nowhere/at/all', runCommand: 'x' }],
    () => false
  )
  check('listeners matching no project are dropped', elsewhere.length === 0, `${elsewhere.length}`)

  await new Promise<void>((resolve) => outside.close(() => resolve()))

  // --- port ownership ----------------------------------------------------
  // A real listener, so lsof is exercised rather than mocked: the whole value
  // of this feature is that it reports what the OS actually says.
  const owned = createServer(() => {})
  await new Promise<void>((resolve) => owned.listen(4711, '0.0.0.0', resolve))

  const holder = await whoHolds(4711)
  check('whoHolds finds the process on a held port', holder?.pid === process.pid, `${holder?.pid}`)
  check('whoHolds reports a command', !!holder?.command && holder.command !== 'unknown', holder?.command)
  check(
    'whoHolds reports the working directory',
    holder?.cwd === process.cwd(),
    `${holder?.cwd}`
  )
  check('whoHolds reports a process group', typeof holder?.pgid === 'number')
  check('whoHolds returns null for a port nobody holds', (await whoHolds(4712)) === null)

  // Safety: the group may only be signalled when the listener leads it. A
  // group it merely belongs to is somebody else's — a shell job, a parent
  // script, this very test runner — and killing that because a port was busy
  // would take down far more than the dev server in question.
  check(
    'a process that leads its own group may be group-killed',
    holder ? groupIsSafeToKill({ ...holder, pgid: holder.pid }) : false
  )
  check(
    'a process that merely belongs to a group may not be',
    holder ? !groupIsSafeToKill({ ...holder, pgid: holder.pid + 1 }) : false
  )
  check(
    'nothing is group-killed when the group id is unknown',
    holder ? !groupIsSafeToKill({ ...holder, pgid: null }) : false
  )

  // --- conflict tiers ----------------------------------------------------
  const here = process.cwd()
  const tierProjects: ProjectConfig[] = [
    { id: 'mine', name: 'mine', path: here, runCommand: 'x' },
    { id: 'other', name: 'other', path: '/nowhere/at/all', runCommand: 'x' }
  ]

  const asRunner = await classify(
    tierProjects[1],
    4711,
    tierProjects,
    (id) => (id === 'mine' ? 4242 : null),
    []
  )
  check('a process Runner started is the runner tier', asRunner.tier === 'runner', asRunner.tier)
  check('the runner tier names the project holding the port', asRunner.ownerProjectName === 'mine')

  const asKnown = await classify(tierProjects[1], 4711, tierProjects, () => null, [3001])
  check('a matching directory with no Runner pid is the known tier', asKnown.tier === 'known', asKnown.tier)
  check('free ports are carried through as alternatives', asKnown.alternatives.join() === '3001')

  const asUnknown = await classify(tierProjects[1], 4711, [tierProjects[1]], () => null, [])
  check('a directory matching no project is the unknown tier', asUnknown.tier === 'unknown', asUnknown.tier)
  check('the unknown tier still reports the pid', asUnknown.owner?.pid === process.pid)

  // A dev server run from a subdirectory of a configured project is still that
  // project's process.
  check(
    'a subdirectory of a project matches that project',
    projectAt(join(here, 'src/main'), tierProjects)?.id === 'mine'
  )
  check('an unrelated directory matches nothing', projectAt('/var/log', tierProjects) === null)
  check('a null working directory matches nothing', projectAt(null, tierProjects) === null)

  // Nested projects: the deeper configured root is the more specific claim.
  const nested: ProjectConfig[] = [
    { id: 'outer', name: 'outer', path: here, runCommand: 'x' },
    { id: 'inner', name: 'inner', path: join(here, 'src'), runCommand: 'x' }
  ]
  check(
    'the deepest matching project wins',
    projectAt(join(here, 'src/main'), nested)?.id === 'inner'
  )

  await new Promise<void>((resolve) => owned.close(() => resolve()))

  // --- freeing a port ----------------------------------------------------
  // A separate process, because killOwner really does kill what it is given.
  const victim = spawn(process.execPath, [
    '-e',
    "require('http').createServer(()=>{}).listen(4713,()=>console.log('up'))"
  ])
  // Bounded, and reported: waiting forever turns a stale listener on 4713 —
  // exactly what a broken killOwner leaves behind — into a suite that prints
  // nothing at all and exits 0, which reads as "no tests" rather than "bug".
  const victimUp = await Promise.race([
    new Promise<boolean>((resolve) => victim.stdout.once('data', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))
  ])
  check('the victim process started', victimUp, 'is something already on 4713?')

  const victimOwner = await whoHolds(4713)
  check('the victim is found on its port', victimOwner?.pid === victim.pid, `${victimOwner?.pid}`)

  const killed = victimOwner
    ? await killOwner(victimOwner, 4713)
    : { ok: false as const, reason: 'not found' }
  check('killOwner reports success', killed.ok, 'reason' in killed ? killed.reason : '')
  check('the port is actually free afterwards', await isPortFree(4713))
  check('the process is really gone', (await whoHolds(4713)) === null)

  // --- shell selection ---------------------------------------------------
  // Regression: an inherited SHELL (from `open`, a launcher, a parent script)
  // must not win over the user's real login shell, or commands run with a
  // different PATH than the terminal they were tested in.
  const realShell = userInfo().shell
  process.env.SHELL = '/bin/definitely-not-my-shell'
  check(
    'defaultShell ignores an inherited $SHELL in favour of the login shell',
    defaultShell() === realShell,
    `got ${defaultShell()}, login shell is ${realShell}`
  )
  delete process.env.SHELL
  check('defaultShell still resolves with no $SHELL at all', defaultShell() === realShell)

  // --- port resolution ---------------------------------------------------
  // 3000 held dual-stack (Node's default, like most dev servers), 3001 held on
  // IPv4 loopback only — both must read as busy.
  const dualStack = createServer()
  dualStack.listen(3000)
  const v4Only = createServer()
  v4Only.listen(3001, '127.0.0.1')
  const blockers = [dualStack, v4Only]
  await new Promise((r) => setTimeout(r, 400))

  check('isPortFree sees a dual-stack listener', (await isPortFree(3000)) === false)
  check('isPortFree sees an IPv4-loopback-only listener', (await isPortFree(3001)) === false)
  check('isPortFree sees a genuinely free port', (await isPortFree(3002)) === true)
  const fellBack = await resolvePort([3000, 3001, 3002])
  check('resolvePort skips busy ports', fellBack === 3002, `got ${fellBack}`)

  const exhausted = await resolvePort([3000, 3001])
  check(
    'resolvePort returns null when every listed port is busy',
    exhausted === null,
    `got ${exhausted}`
  )

  check(
    'waitForPortsFree gives up on a port nobody releases',
    (await waitForPortsFree([3000], 500)) === false
  )
  setTimeout(() => v4Only.close(), 300)
  check('waitForPortsFree resolves once a port is released', await waitForPortsFree([3001], 4000))
  v4Only.listen(3001, '127.0.0.1')
  await new Promise((r) => setTimeout(r, 300))

  // --- migrating away from Docker projects --------------------------------
  // An old config's Docker project has no runCommand of its own, so without a
  // migration it would fail validation and read to the user as data loss.
  const migrated = validateConfig(
    migrate({
      projects: [
        {
          id: 'stack',
          name: 'stack',
          path: '~/x',
          kind: 'docker',
          docker: { file: 'compose.yaml', services: ['api'], build: true }
        }
      ]
    })
  )
  check(
    'an old Docker project migrates into a plain command',
    migrated.ok &&
      migrated.config.projects[0].runCommand ===
        "docker compose -f 'compose.yaml' up --build 'api'",
    migrated.ok ? '' : JSON.stringify(migrated.issues)
  )
  check(
    'migration drops the kind and docker keys',
    migrated.ok && !('kind' in migrated.config.projects[0]) && !('docker' in migrated.config.projects[0])
  )

  const migratedContainer = validateConfig(
    migrate({
      projects: [
        { name: 'pg', path: '~/x', kind: 'docker', docker: { mode: 'container', container: 'my pg' } }
      ]
    })
  )
  check(
    'a single-container project migrates to start plus logs',
    migratedContainer.ok &&
      migratedContainer.config.projects[0].runCommand ===
        "docker start 'my pg' && docker logs -f --tail 200 'my pg'",
    migratedContainer.ok ? '' : JSON.stringify(migratedContainer.issues)
  )

  const keptCommand = migrate({
    projects: [{ name: 'x', path: '~/x', kind: 'docker', runCommand: 'docker compose up db' }]
  }) as { projects: { runCommand: string }[] }
  check(
    'a Docker project with its own command keeps it',
    keptCommand.projects[0].runCommand === 'docker compose up db'
  )

  // --- auto-open and auto-restart validation ------------------------------
  const autos = validateConfig({
    projects: [
      {
        name: 'a',
        path: '~/x',
        runCommand: 'c',
        autoOpen: true,
        autoRestart: { enabled: true, maxAttempts: 5, delayMs: 500 }
      }
    ]
  })
  check(
    'autoOpen and autoRestart survive validation',
    autos.ok &&
      autos.config.projects[0].autoOpen === true &&
      autos.config.projects[0].autoRestart?.maxAttempts === 5 &&
      autos.config.projects[0].autoRestart?.delayMs === 500,
    autos.ok ? '' : JSON.stringify(autos.issues)
  )

  const shorthand = validateConfig({
    projects: [{ name: 'a', path: '~/x', runCommand: 'c', autoRestart: true }]
  })
  check(
    '`autoRestart: true` is read as enabled with the defaults',
    shorthand.ok && shorthand.config.projects[0].autoRestart?.enabled === true
  )

  const offRestart = validateConfig({
    projects: [{ name: 'a', path: '~/x', runCommand: 'c', autoRestart: false }]
  })
  check(
    '`autoRestart: false` leaves nothing behind',
    offRestart.ok && offRestart.config.projects[0].autoRestart === undefined
  )

  const badAttempts = validateConfig({
    projects: [{ name: 'a', path: '~/x', runCommand: 'c', autoRestart: { enabled: true, maxAttempts: 0 } }]
  })
  check('an out-of-range maxAttempts is rejected', !badAttempts.ok)

  const badAutoOpen = validateConfig({
    projects: [{ name: 'a', path: '~/x', runCommand: 'c', autoOpen: 'yes' }]
  })
  check('a non-boolean autoOpen is rejected', !badAutoOpen.ok)

  const commandNeedsCommand = validateConfig({ projects: [{ name: 'x', path: '~/x' }] })
  check('a command project still requires runCommand', !commandNeedsCommand.ok)

  // --- dependency validation --------------------------------------------
  const selfDep = validateConfig({
    projects: [{ id: 'a', name: 'a', path: '~/x', runCommand: 'c', dependsOn: ['a'] }]
  })
  check('a project cannot depend on itself', !selfDep.ok)

  const ghostDep = validateConfig({
    projects: [{ id: 'a', name: 'a', path: '~/x', runCommand: 'c', dependsOn: ['nope'] }]
  })
  check('a dependency on a missing project is rejected', !ghostDep.ok)

  const cyclic = validateConfig({
    projects: [
      { id: 'a', name: 'a', path: '~/x', runCommand: 'c', dependsOn: ['b'] },
      { id: 'b', name: 'b', path: '~/x', runCommand: 'c', dependsOn: ['c'] },
      { id: 'c', name: 'c', path: '~/x', runCommand: 'c', dependsOn: ['a'] }
    ]
  })
  check(
    'a dependency cycle is rejected and named',
    !cyclic.ok && cyclic.issues.some((i) => i.message.includes('Dependency cycle')),
    cyclic.ok ? '' : cyclic.issues.map((i) => i.message).join(' | ')
  )

  const chain = validateConfig({
    projects: [
      { id: 'web', name: 'web', path: '~/x', runCommand: 'c', dependsOn: ['api', 'api'] },
      { id: 'api', name: 'api', path: '~/x', runCommand: 'c', dependsOn: ['db'] },
      { id: 'db', name: 'db', path: '~/x', runCommand: 'c' }
    ]
  })
  check(
    'a valid chain survives validation with deduped edges',
    chain.ok && chain.config.projects[0].dependsOn!.length === 1,
    chain.ok ? '' : JSON.stringify(chain.issues)
  )

  const readinessBad = validateConfig({
    projects: [{ name: 'a', path: '~/x', runCommand: 'c', readiness: { logPattern: '([' } }]
  })
  check('an invalid readiness regex is rejected', !readinessBad.ok)

  // --- graph shape -------------------------------------------------------
  const graph: ProjectConfig[] = [
    { id: 'web', name: 'web', path: APP, runCommand: 'c', dependsOn: ['api'] },
    { id: 'api', name: 'api', path: APP, runCommand: 'c', dependsOn: ['db'] },
    { id: 'db', name: 'db', path: APP, runCommand: 'c' },
    { id: 'solo', name: 'solo', path: APP, runCommand: 'c' }
  ]
  check(
    'startOrder returns dependencies first',
    startOrder(graph, 'web').map((p) => p.id).join(',') === 'db,api,web',
    startOrder(graph, 'web').map((p) => p.id).join(',')
  )
  check('dependentsOf finds the direct parent', dependentsOf(graph, 'db').join(',') === 'api')

  const tree = buildTree(graph)
  check(
    'the tree roots are the projects nothing depends on',
    tree.map((n) => n.project.id).join(',') === 'web,solo',
    tree.map((n) => n.project.id).join(',')
  )
  check(
    'the tree nests dependencies under their dependents',
    tree[0].children[0].project.id === 'api' &&
      tree[0].children[0].children[0].project.id === 'db' &&
      tree[0].children[0].children[0].depth === 2
  )
  check('findCycles is quiet on an acyclic graph', findCycles(graph).length === 0)

  // A cycle has no root at all, so the tree must still surface its members
  // rather than silently dropping them from the sidebar.
  const loop: ProjectConfig[] = [
    { id: 'a', name: 'a', path: APP, runCommand: 'c', dependsOn: ['b'] },
    { id: 'b', name: 'b', path: APP, runCommand: 'c', dependsOn: ['a'] }
  ]
  check('findCycles reports a two-node loop once', findCycles(loop).length === 1)
  // A cycle has no root, so it is entered at an arbitrary member and unrolled
  // once. What matters is that both projects stay reachable in the sidebar.
  const loopTree = buildTree(loop)
  const loopIds = new Set<string>()
  const walk = (nodes: ReturnType<typeof buildTree>): void => {
    for (const node of nodes) {
      loopIds.add(node.project.id)
      walk(node.children)
    }
  }
  walk(loopTree)
  check(
    'buildTree still shows every project in a cyclic config',
    loopIds.size === 2,
    [...loopIds].join(',')
  )
  check('buildTree does not recurse forever on a cycle', loopTree[0].children.length === 1)

  // --- real process lifecycle -------------------------------------------
  const manager = new ProcessManager()
  const runtimes = new Map<string, ProjectRuntime>()
  manager.on('runtime', (r) => runtimes.set(r.id, r))
  let output = ''
  manager.on('data', (_id, chunk) => (output += chunk))

  const project: ProjectConfig = {
    id: 'p1',
    name: 'fake app',
    path: APP,
    runCommand: 'npm run dev',
    port: [3000, 3001, 3002],
    env: { GREETING: 'hello-from-runner' }
  }

  await manager.start(project)
  const started = await waitFor(() => output.includes('ready on http://localhost:'))
  check('project starts and reaches "ready"', started)

  const rt = runtimes.get('p1')!
  check('runtime reports running', rt.status === 'running', rt.status)
  check('port fell back past the two busy ports', rt.port === 3002, `got ${rt.port}`)
  check('child actually bound the assigned port', output.includes('ready on http://localhost:3002'))
  check('custom env var reached the child', output.includes('GREETING=hello-from-runner'))
  check('busy-port notice was printed', output.includes('is busy — using 3002'))
  check(
    'port was detected from the child output',
    rt.detectedPorts.includes(3002),
    `got [${rt.detectedPorts}]`
  )
  check('port 3002 is now occupied by the child', (await isPortFree(3002)) === false)

  // restart: same manager, process should come back up
  output = ''
  await manager.restart(project)
  const restarted = await waitFor(() => output.includes('ready on http://localhost:'))
  check('restart brings the project back up', restarted)
  const rt2 = runtimes.get('p1')!
  check('restart reports running again', rt2.status === 'running', rt2.status)
  check('restart got a fresh pid', rt2.pid !== rt.pid, `${rt.pid} -> ${rt2.pid}`)

  // stop
  manager.stop('p1')
  const stopped = await waitFor(() => runtimes.get('p1')?.status === 'stopped')
  check('stop reaches "stopped"', stopped, runtimes.get('p1')?.status)
  check('SIGTERM was delivered to the child', output.includes('got SIGTERM'))
  await new Promise((r) => setTimeout(r, 600))
  check('port is released after stop', (await isPortFree(3002)) === true)
  check('no sessions left running', manager.runningCount() === 0)

  // --- restart against a port the project itself is still holding --------
  // The regression: killing the process group ends the shell Runner watches,
  // but the dev server it spawned keeps the socket for a moment longer. A
  // restart that spawns the instant the PTY exits used to find its own port
  // taken and report "all ports are in use" — so the user had to click twice.
  const lingering: ProjectConfig = {
    id: 'p6',
    name: 'lingering',
    path: LINGERING,
    runCommand: 'npm run dev',
    port: [3020]
  }
  let lingeringOutput = ''
  const lingeringManager = new ProcessManager()
  const lingeringRuntimes = new Map<string, ProjectRuntime>()
  lingeringManager.on('runtime', (r) => lingeringRuntimes.set(r.id, r))
  lingeringManager.on('data', (_id, chunk) => (lingeringOutput += chunk))

  await lingeringManager.start(lingering)
  await waitFor(() => lingeringOutput.includes('lingering app ready on http://localhost:3020'))
  lingeringOutput = ''
  await lingeringManager.restart(lingering)
  const cameBack = await waitFor(
    () => lingeringOutput.includes('lingering app ready on http://localhost:3020'),
    20000
  )
  check('restart survives the project still holding its own port', cameBack, lingeringOutput.slice(-300))
  check(
    'restart does not report the port as busy',
    !lingeringOutput.includes('All ports are in use'),
    lingeringOutput.slice(-300)
  )
  check(
    'restart came back on the same port rather than falling forward',
    lingeringRuntimes.get('p6')?.port === 3020,
    `${lingeringRuntimes.get('p6')?.port}`
  )
  check(
    'restart says what it is waiting for',
    lingeringOutput.includes('waiting for 3020 to be released')
  )
  await lingeringManager.stopAll()
  await waitForPortsFree([3020], 5000)

  // --- auto-open ---------------------------------------------------------
  // The URL must not be handed over until the port actually answers, or the
  // browser opens on a connection error and the user refreshes by hand.
  const openManager = new ProcessManager()
  const opened: string[] = []
  let servingWhenOpened: boolean | null = null
  openManager.on('open', (_id, url) => {
    opened.push(url)
  })
  const openProject: ProjectConfig = {
    id: 'p7',
    name: 'opener',
    path: APP,
    runCommand: 'npm run dev',
    port: [3021],
    autoOpen: true,
    protocol: 'https'
  }
  await openManager.start(openProject)
  const didOpen = await waitFor(() => opened.length > 0)
  if (didOpen) servingWhenOpened = !(await isPortFree(3021))
  check('auto-open fires once the project is up', didOpen, opened.join(','))
  check('auto-open uses the configured protocol and port', opened[0] === 'https://localhost:3021', opened[0])
  check('auto-open waited for the port to answer', servingWhenOpened === true)
  await openManager.stopAll()

  const quietManager = new ProcessManager()
  const quietOpens: string[] = []
  quietManager.on('open', (_id, url) => quietOpens.push(url))
  await quietManager.start({ ...openProject, id: 'p8', name: 'quiet', autoOpen: false, port: [3022] })
  await new Promise((r) => setTimeout(r, 1500))
  check('nothing is opened when auto-open is off', quietOpens.length === 0, quietOpens.join(','))
  await quietManager.stopAll()

  // --- auto-restart ------------------------------------------------------
  const crashManager = new ProcessManager()
  const crashRuntimes = new Map<string, ProjectRuntime>()
  crashManager.on('runtime', (r) => crashRuntimes.set(r.id, r))
  let crashOutput = ''
  crashManager.on('data', (_id, chunk) => (crashOutput += chunk))
  const crasher: ProjectConfig = {
    id: 'p9',
    name: 'crasher',
    path: APP,
    runCommand: 'exit 7',
    autoRestart: { enabled: true, maxAttempts: 2, delayMs: 100 }
  }

  await crashManager.start(crasher)
  const gaveUp = await waitFor(() => crashOutput.includes('auto-restart gave up'), 20000)
  check('auto-restart retries a crash and eventually gives up', gaveUp, crashOutput.slice(-300))
  check(
    'auto-restart honours the attempt budget',
    (crashOutput.match(/auto-restarting in/g) ?? []).length === 2,
    `${(crashOutput.match(/auto-restarting in/g) ?? []).length} attempts`
  )
  check(
    'the retry counter is cleared once Runner gives up',
    crashRuntimes.get('p9')?.restartAttempts === 0,
    `${crashRuntimes.get('p9')?.restartAttempts}`
  )
  check('the project is left reported as crashed', crashRuntimes.get('p9')?.status === 'exited')

  // A stop the user asked for is not a crash, so nothing should come back.
  const cleanManager = new ProcessManager()
  let cleanOutput = ''
  cleanManager.on('data', (_id, chunk) => (cleanOutput += chunk))
  const watched: ProjectConfig = {
    id: 'p10',
    name: 'watched',
    path: APP,
    runCommand: 'npm run dev',
    port: [3023],
    autoRestart: { enabled: true, maxAttempts: 3, delayMs: 100 }
  }
  await cleanManager.start(watched)
  await waitFor(() => cleanOutput.includes('ready on http://localhost:3023'))
  cleanManager.stop('p10')
  await waitFor(() => !cleanManager.isRunning('p10'))
  await new Promise((r) => setTimeout(r, 1200))
  check('a deliberate stop is not auto-restarted', !cleanManager.isRunning('p10'))
  check(
    'a deliberate stop schedules no retry',
    !cleanOutput.includes('auto-restarting in'),
    cleanOutput.slice(-200)
  )
  await cleanManager.stopAll()

  // --- port availability for the UI --------------------------------------
  const busyProject: ProjectConfig = { ...project, id: 'p4', name: 'busy', port: [3000, 3001] }
  await manager.refreshPortAvailability([busyProject])
  check('portsBusy set when every listed port is taken', runtimes.get('p4')?.portsBusy === true)

  // Read from the manager, not the event map: an unchanged value emits nothing,
  // which is deliberate — the UI must not be spammed every poll.
  const freeProject: ProjectConfig = { ...project, id: 'p5', name: 'free', port: [3002] }
  await manager.refreshPortAvailability([freeProject])
  check('portsBusy clear while a listed port is free', manager.runtime('p5').portsBusy === false)
  check('an unchanged portsBusy emits no runtime event', !runtimes.has('p5'))

  await manager.start(busyProject)
  check(
    'start refuses when every listed port is taken',
    runtimes.get('p4')?.status === 'error' && runtimes.get('p4')?.portsBusy === true,
    `${runtimes.get('p4')?.status} / ${runtimes.get('p4')?.message}`
  )

  // missing directory
  await manager.start({ id: 'p2', name: 'ghost', path: '/no/such/dir', runCommand: 'ls' })
  check('missing directory reports an error', runtimes.get('p2')?.status === 'error')

  // non-zero exit is surfaced as a crash
  await manager.start({ id: 'p3', name: 'boom', path: APP, runCommand: 'exit 3' })
  const crashed = await waitFor(() => runtimes.get('p3')?.status === 'exited')
  check('non-zero exit is reported as crashed', crashed, runtimes.get('p3')?.status)
  check('exit code is captured', runtimes.get('p3')?.exitCode === 3, `${runtimes.get('p3')?.exitCode}`)

  // stopAll tears everything down
  await manager.start(project)
  await waitFor(() => manager.runningCount() === 1)
  await manager.stopAll()
  check('stopAll leaves nothing running', manager.runningCount() === 0)

  // --- dependency trees, for real ----------------------------------------
  // web depends on api depends on db; each is the fake dev server on its own
  // port, so "ready" means a socket actually answering, not just a live pid.
  const treeProjects: ProjectConfig[] = [
    { id: 'db', name: 'db', path: APP, runCommand: 'npm run dev', port: [3010] },
    { id: 'api', name: 'api', path: APP, runCommand: 'npm run dev', port: [3011], dependsOn: ['db'] },
    { id: 'web', name: 'web', path: APP, runCommand: 'npm run dev', port: [3012], dependsOn: ['api'] }
  ]
  const treeManager = new ProcessManager()
  const orchestrator = new Orchestrator(treeManager, () => treeProjects)
  const startSequence: string[] = []
  treeManager.on('runtime', (r) => {
    if (r.status === 'running' && !startSequence.includes(r.id)) startSequence.push(r.id)
  })

  const treeResult = await orchestrator.startTree('web')
  check('startTree reports success', treeResult.ok, treeResult.message ?? '')
  check(
    'the whole tree came up',
    ['db', 'api', 'web'].every((id) => treeManager.isRunning(id)),
    startSequence.join(',')
  )
  check(
    'dependencies came up before their dependents',
    startSequence.join(',') === 'db,api,web',
    startSequence.join(',')
  )
  // The root is not waited on — nothing depends on it — so give it the moment
  // it needs to bind before asserting the whole tree is actually serving.
  const rootServing = await waitFor(async () => !(await isPortFree(3012)))
  check('every project in the tree is serving', rootServing)
  check(
    'nothing is left waiting once the tree is up',
    treeProjects.every((p) => treeManager.runtime(p.id).waitingFor === null)
  )

  // Stopping the root must not take down a dependency another live project
  // still needs, so give api a second dependent and stop only that one.
  treeProjects.push({
    id: 'other',
    name: 'other',
    path: APP,
    runCommand: 'npm run dev',
    port: [3013],
    dependsOn: ['api']
  })
  await orchestrator.startTree('other')
  await orchestrator.stopTree('other')
  await waitFor(() => !treeManager.isRunning('other'))
  check('stopTree stops the project it was asked about', !treeManager.isRunning('other'))
  check(
    'stopTree leaves a dependency that another live project needs',
    treeManager.isRunning('api') && treeManager.isRunning('db')
  )

  treeProjects.pop()
  await orchestrator.stopTree('web')
  const treeDown = await waitFor(() => treeManager.runningCount() === 0)
  check('stopTree brings the whole tree down', treeDown, `${treeManager.runningCount()} left`)

  // A dependency that cannot start must stop the tree rather than launch a
  // dependent into a world where its backend does not exist.
  const brokenProjects: ProjectConfig[] = [
    { id: 'bad', name: 'bad', path: '/no/such/dir', runCommand: 'npm run dev' },
    { id: 'needy', name: 'needy', path: APP, runCommand: 'npm run dev', port: [3014], dependsOn: ['bad'] }
  ]
  const brokenManager = new ProcessManager()
  const brokenOrchestrator = new Orchestrator(brokenManager, () => brokenProjects)
  const brokenResult = await brokenOrchestrator.startTree('needy')
  check('a failing dependency fails the tree start', !brokenResult.ok)
  check('the dependent is never started', !brokenManager.isRunning('needy'))
  check(
    'the dependent explains which dependency failed',
    brokenManager.runtime('needy').status === 'error' &&
      (brokenManager.runtime('needy').message ?? '').includes('bad'),
    `${brokenManager.runtime('needy').status}: ${brokenManager.runtime('needy').message}`
  )
  await brokenManager.stopAll()

  // A log pattern is the readiness signal for anything that never binds a port.
  const logReady: ProjectConfig[] = [
    {
      id: 'silent',
      name: 'silent',
      path: APP,
      runCommand: 'npm run dev',
      port: [3015],
      readiness: { logPattern: 'ready on http', timeoutMs: 15000 }
    },
    { id: 'after', name: 'after', path: APP, runCommand: 'npm run dev', port: [3016], dependsOn: ['silent'] }
  ]
  const logManager = new ProcessManager()
  const logOrchestrator = new Orchestrator(logManager, () => logReady)
  const logResult = await logOrchestrator.startTree('after')
  check('a log pattern satisfies readiness', logResult.ok, logResult.message ?? '')
  await logManager.stopAll()

  // waitForPort is what "ready" ultimately rests on.
  const probe = createServer()
  probe.listen(3017)
  await new Promise((r) => setTimeout(r, 200))
  check('waitForPort sees a live listener', (await waitForPort(3017, 2000)) === true)
  probe.close()
  await new Promise((r) => setTimeout(r, 200))
  check('waitForPort gives up on a dead port', (await waitForPort(3017, 800)) === false)

  await treeManager.stopAll()

  blockers.forEach((s) => s.close())
  console.log(results.join('\n'))
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
