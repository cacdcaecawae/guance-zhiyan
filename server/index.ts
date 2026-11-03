import { resolve } from 'node:path'
import { Store } from './store.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { localAuthenticate } from './auth.ts'
import { Accounts } from './accounts.ts'
import { configureNetwork } from './network.ts'
import { sandboxConfig, Sandboxes } from './sandboxes.ts'
import { LibraryStore } from './rag-store.ts'
import { KnowledgeLibrary, ragConfig } from './rag.ts'
import { modelCatalog } from './models.ts'

const port = Number(process.env.PORT ?? 3001)
const local = process.argv.includes('--local')
const origin = local
  ? `http://127.0.0.1:${port}`
  : (process.env.APP_ORIGIN ?? 'http://localhost:5173')
if (!Number.isInteger(port) || port < 1 || port > 65535 || new URL(origin).origin !== origin)
  throw new Error('PORT 或 APP_ORIGIN 配置无效。')
modelCatalog() // MODEL_PROVIDERS 无效时启动即报错
const store = new Store(resolve(process.env.DATA_DIR ?? 'server/data'))
const disposeNetwork = await configureNetwork()
process.env.DSH_HOME = resolve(store.root, 'dsh')
const sandboxOptions = sandboxConfig()
const sandboxes = sandboxOptions ? await new Sandboxes(store, sandboxOptions).init() : undefined
const library = new KnowledgeLibrary(new LibraryStore(store), ragConfig())
const agents = await new Agents(store, { sandboxes, library }).init()
// 服务器模式用本地账号登录；Cookie 是否加 Secure 由浏览器访问的 APP_ORIGIN 决定，不看转发头
const accounts = local
  ? undefined
  : new Accounts(store, {
      secure: origin.startsWith('https:'),
      trustProxy: process.env.TRUST_PROXY === '1',
    })
const server = createApp(store, agents, {
  origin,
  dist: resolve('dist'),
  library: library.documents,
  search: (query, signal) => library.retrieve(query, signal, undefined, 20),
  ...(accounts ? { accounts } : { authenticate: localAuthenticate(origin) }),
})
server.listen(port, local ? '127.0.0.1' : (process.env.HOST ?? '127.0.0.1'), () => {
  console.info(
    local
      ? `本机聊天已启动：${origin}（无需登录，仅供本机使用）。`
      : `网站已启动：${origin}（账号登录，端口 ${port}）。`,
  )
  if (accounts && !accounts.list().length)
    console.info('尚未创建账号：运行 pnpm account add <用户名> 后即可登录。')
  if (!modelCatalog().providers.some((provider) => provider.configured))
    console.info(
      '尚未配置供应商密钥，请在 server/.env 中填写 DEEPSEEK_API_KEY、QIANWEN_API_KEY 或 CAMPUS_API_KEY 后重启。',
    )
})
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  server.close()
  server.closeAllConnections()
  await agents.close()
  await disposeNetwork()
  store.close()
}
process.once('SIGINT', () => {
  void shutdown()
})
process.once('SIGTERM', () => {
  void shutdown()
})
