const { execFileSync } = require('node:child_process')
const { cpSync, mkdirSync, rmSync, existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * Stages the packaged app plus its install notes and zips them for transfer.
 *
 * Uses `ditto` rather than `zip`: an Electron bundle contains symlinks inside
 * Frameworks, and a plain `zip -r` dereferences them, which produces an archive
 * whose extracted app fails signature verification.
 */
const root = join(__dirname, '..')
const version = require(join(root, 'package.json')).version
const appDir = join(root, 'release', 'mac-arm64')
const app = join(appDir, 'Runner.app')

if (!existsSync(app)) {
  console.error(`No packaged app at ${app} — run \`npm run dist\` first.`)
  process.exit(1)
}

const stageName = `Runner-${version}-arm64`
const stage = join(root, 'release', stageName)
const zip = join(root, 'release', `${stageName}.zip`)

rmSync(stage, { recursive: true, force: true })
rmSync(zip, { force: true })
mkdirSync(stage, { recursive: true })

cpSync(app, join(stage, 'Runner.app'), { recursive: true, verbatimSymlinks: true })
cpSync(join(__dirname, 'INSTALL.md'), join(stage, 'INSTALL.md'))

// A convenience wrapper for the two install steps. Documented as optional in
// INSTALL.md, because a copy-paste of the two commands is just as good.
writeFileSync(
  join(stage, 'install-to-applications.command'),
  `#!/bin/zsh
# Double-click to install. Equivalent to the two commands in INSTALL.md.
set -e
cd "$(dirname "$0")"
echo "Copying Runner.app to /Applications…"
rm -rf /Applications/Runner.app
cp -R Runner.app /Applications/
echo "Clearing the quarantine flag…"
xattr -cr /Applications/Runner.app
echo "Done. Opening Runner."
open /Applications/Runner.app
`,
  { mode: 0o755 }
)

execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stage, zip], {
  stdio: 'inherit'
})
rmSync(stage, { recursive: true, force: true })

console.log(`  • wrote ${zip}`)
