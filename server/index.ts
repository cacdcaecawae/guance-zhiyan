import { resolve } from 'node:path'
import { Store } from './store.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { localAuthenticate } from './auth.ts'
import { configureNetwork } from './network.ts'
import { sandboxConfig, Sandboxes } from './sandboxes.ts'

const port = Number(process.env.PORT ?? 3001)
const local = process.argv.includes('--local')
const origin = local
  ? `http://127.0.0.1:${port}`
  : (process.env.APP_ORIGIN ?? 'http://localhost:5173')
if (!Number.isInteger(port) || port < 1 || port > 65535 || new URL(origin).origin !== origin)
  throw new Error('PORT 或 APP_ORIGIN 配置无效。')
const store = new Store(resolve(process.env.DATA_DIR ?? 'server/data'))
const disposeNetwork = await configureNetwork()
process.env.DSH_HOME = resolve(store.root, 'dsh')
const sandboxOptions = sandboxConfig()
const sandboxes = sandboxOptions ? await new Sandboxes(store, sandboxOptions).init() : undefined
const agents = await new Agents(store, { sandboxes }).init()
const server = createApp(store, agents, {
  origin,
  dist: resolve('dist'),
  ...(local ? { authenticate: localAuthenticate(origin) } : {}),
})
server.listen(port, local ? '127.0.0.1' : (process.env.HOST ?? '127.0.0.1'), () => {
  console.info(
    local
      ? `本机聊天已启动：${origin}（无需登录，仅供本机使用）。`
      : `后端已启动，端口 ${port}。学校身份认证尚未接入。`,
  )
  if (!process.env.DEEPSEEK_API_KEY?.trim() && !process.env.QIANWEN_API_KEY?.trim())
    console.info(
      '尚未配置供应商密钥，请在 server/.env 中填写 DEEPSEEK_API_KEY 或 QIANWEN_API_KEY 后重启。',
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
