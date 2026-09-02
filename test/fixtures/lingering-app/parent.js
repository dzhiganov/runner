// Stands in for `npm run dev`: it spawns the real server and gets out of the
// way the instant it is asked to stop, which is exactly what leaves the port
// held by a process Runner is no longer attached to.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
spawn(process.execPath, [join(here, 'server.js')], { stdio: 'inherit' })

process.on('SIGTERM', () => process.exit(0))
// Nothing else keeps this alive once the child is detached from our event loop.
setInterval(() => {}, 1000)
