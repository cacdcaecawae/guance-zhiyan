/** Isolated test host: production never imports this entry point. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Store } from '../../server/store.ts'
import { Agents } from '../../server/agent.ts'
import { createApp } from '../../server/http.ts'
import { TestModel } from './model.ts'

const root = await mkdtemp(join(tmpdir(), 'gczy-browser-test-'))
const store = new Store(root)
const agents = await new Agents(store, { adapter: new TestModel() }).init()
const server = createApp(store, agents, {
  origin: 'http://localhost:4173',
  authenticate: async (request) => {
    const subject = /(?:^|;\s*)test_user=([\w-]+)/.exec(request.headers.cookie ?? '')?.[1]
    return subject ? { subject, name: '自动化测试用户' } : undefined
  },
})
server.listen(Number(process.env.E2E_BACKEND_PORT ?? 3001), '127.0.0.1')
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  server.close()
  server.closeAllConnections()
  await agents.close()
  store.close()
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('gczy-browser-test-'))
    throw new Error('Unexpected temporary directory')
  await rm(root, { recursive: true })
}
process.once('SIGTERM', () => {
  void shutdown()
})
process.once('SIGINT', () => {
  void shutdown()
})
