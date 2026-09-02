// Stand-in dev server used by the test suite: binds PORT, echoes an env var,
// and exits cleanly on SIGTERM so teardown can be asserted.
import { createServer } from 'node:http'

const port = Number(process.env.PORT || 8080)
console.log(`fake app booting (GREETING=${process.env.GREETING ?? 'none'})`)

createServer((_req, res) => res.end('ok')).listen(port, () => {
  console.log(`ready on http://localhost:${port}`)
})

process.on('SIGTERM', () => {
  console.log('got SIGTERM, closing')
  process.exit(0)
})
