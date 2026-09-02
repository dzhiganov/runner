const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

/**
 * Ad-hoc signs the packaged bundle.
 *
 * The linker leaves a thin signature on the executable only (`Info.plist=not
 * bound`), which macOS accepts while the app is local and unquarantined. As
 * soon as the app is copied to another machine it picks up a quarantine flag,
 * and an arm64 bundle with an incomplete signature is then refused outright —
 * "Runner is damaged" — which right-click → Open does not clear.
 *
 * This does not make the app notarised; the receiving Mac still has to strip
 * the quarantine attribute. It makes it launchable once they do.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`  • ad-hoc signing  ${app}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
