import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { Store, HttpError } from './store.ts'
import { Agents } from './agent.ts'
import { MIME } from './artifacts.ts'
import { authenticate as defaultAuthenticate, type Authenticate } from './auth.ts'

async function body(request: IncomingMessage) {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new HttpError(415, '请求必须为 JSON。')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 32000) throw new HttpError(413, '请求过大。')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown
  } catch {
    throw new HttpError(400, 'JSON 格式错误。')
  }
}
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

/** One process owns active runs. Scale out only with shared execution ownership. */
export function createApp(
  store: Store,
  agents: Agents,
  options: { authenticate?: Authenticate; origin?: string; dist?: string } = {},
) {
  const authenticate = options.authenticate ?? defaultAuthenticate
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (path === '/api/health' && request.method === 'GET')
        return json(response, 200, { status: 'ok' })
      if (!path.startsWith('/api/')) {
        if (request.method !== 'GET' || !options.dist) throw new HttpError(404, '页面不存在。')
        const root = resolve(options.dist)
        const target = resolve(root, '.' + decodeURIComponent(path))
        if (!target.startsWith(root + sep) && target !== root)
          throw new HttpError(404, '页面不存在。')
        const mime: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
        }
        let data: Buffer
        let kind = extname(target)
        try {
          data = await readFile(target)
        } catch {
          if (kind) throw new HttpError(404, '页面不存在。')
          data = await readFile(resolve(root, 'index.html'))
          kind = '.html'
        }
        response.setHeader('Content-Type', mime[kind] ?? 'application/octet-stream')
        return response.end(data)
      }
      const identity = await authenticate(request)
      if (
        !identity ||
        !identity.subject ||
        identity.subject.length > 256 ||
        !identity.name ||
        identity.name.length > 128
      ) {
        throw new HttpError(401, '需要身份认证。学校登录尚未接入，请联系管理员。')
      }
      const user = store.user(identity.subject, identity.name)
      if (request.method !== 'GET') {
        if (
          request.headers['sec-fetch-site'] === 'cross-site' ||
          (request.headers.origin && request.headers.origin !== options.origin)
        ) {
          throw new HttpError(403, '请求来源不被允许。')
        }
      }
      if (path === '/api/me' && request.method === 'GET') return json(response, 200, user)
      if (path === '/api/sessions') {
        if (request.method === 'GET') return json(response, 200, store.list(user.id))
        if (request.method === 'POST') return json(response, 201, store.create(user.id))
      }
      const file = /^\/api\/files\/([0-9a-f-]{36})$/.exec(path)
      if (file && request.method === 'GET') {
        const artifact = store.artifact(user.id, file[1])
        const data = await readFile(agents.files.path(artifact.id))
        response.writeHead(200, {
          'Content-Type': MIME[artifact.format],
          'Content-Disposition': `attachment; filename="download.${artifact.format}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
          'Content-Length': data.length,
        })
        return response.end(data)
      }
      const match = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/(messages|stop|events))?$/.exec(path)
      if (!match) throw new HttpError(404, '接口不存在。')
      const [, id, action] = match
      store.session(user.id, id)
      if (!action && request.method === 'GET')
        return json(response, 200, await agents.snapshot(user.id, id))
      if (action === 'messages' && request.method === 'POST') {
        const input = await body(request)
        if (
          !input ||
          typeof input !== 'object' ||
          !('question' in input) ||
          typeof input.question !== 'string' ||
          !input.question.trim() ||
          input.question.length > 8000
        )
          throw new HttpError(400, '问题须为 1–8000 个字符。')
        await agents.start(user.id, id, input.question.trim())
        return json(response, 202, await agents.snapshot(user.id, id))
      }
      if (action === 'stop' && request.method === 'POST') {
        await agents.stop(user.id, id)
        return json(response, 200, await agents.snapshot(user.id, id))
      }
      if (action === 'events' && request.method === 'GET') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        response.flushHeaders()
        let dirty = true
        let writing = false
        let closed = false
        let batch: ReturnType<typeof setTimeout> | undefined
        const send = async () => {
          if (writing || closed) return
          writing = true
          dirty = false
          try {
            const view = await agents.snapshot(user.id, id)
            if (!closed) {
              response.write(`data: ${JSON.stringify(view)}\n\n`)
              // Bound slow clients without reconnecting every snapshot over 16 KB.
              if (response.writableLength > 1_000_000) response.end()
            }
          } catch {
            if (!closed) response.end('event: failure\ndata: {}\n\n')
          } finally {
            writing = false
            if (dirty && !closed) schedule()
          }
        }
        // Batch token bursts, not request ordering: snapshots are serialized.
        const schedule = () => {
          dirty = true
          if (!batch && !closed)
            batch = setTimeout(() => {
              batch = undefined
              void send()
            }, 50)
        }
        const unsubscribe = agents.subscribe(user.id, id, schedule)
        const heartbeat = setInterval(() => {
          if (!response.writableLength) response.write(': keepalive\n\n')
        }, 15000)
        response.on('close', () => {
          closed = true
          unsubscribe()
          clearInterval(heartbeat)
          clearTimeout(batch)
        })
        void send()
        return
      }
      throw new HttpError(405, '不支持该操作。')
    } catch (error) {
      if (response.headersSent) response.end()
      else
        json(response, error instanceof HttpError ? error.status : 500, {
          error: error instanceof HttpError ? error.message : '服务器处理失败，请重试。',
        })
    }
  })
  server.requestTimeout = 30000
  server.headersTimeout = 15000
  return server
}
