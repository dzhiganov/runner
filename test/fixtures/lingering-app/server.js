// The grandchild: binds PORT and deliberately hangs on to it for a moment
// after SIGTERM, the way a real dev server with open connections does.
import { createServer } from 'node:http'

const port = Number(process.env.PORT || 8080)
const server = createServer((_req, res) => res.end('ok'))
server.listen(port, () => console.log(`lingering app ready on http://localhost:${port}`))

process.on('SIGTERM', () => {
  setTimeout(() => {
    server.close()
    process.exit(0)
  }, 1200)
})
