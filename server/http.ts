import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { Store, HttpError } from './store.ts'
import { Agents } from './agent.ts'
import { modelCatalog, validateSelection } from './models.ts'
import { MIME } from './artifacts.ts'
import type { LibraryStore } from './rag-store.ts'
import { authenticate as defaultAuthenticate, type Authenticate } from './auth.ts'
import { sessionChanges, type SessionFrame } from '../src/services/session-stream.ts'
import type { Session } from '../src/types/index.ts'

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
const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

/** One process owns active runs. Scale out only with shared execution ownership. */
export function createApp(
  store: Store,
  agents: Agents,
  options: {
    authenticate?: Authenticate
    origin?: string
    dist?: string
    library?: LibraryStore
  } = {},
) {
  const authenticate = options.authenticate ?? defaultAuthenticate
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname
      if (path === '/api/health' && request.method === 'GET')
        return json(response, 200, { status: 'ok' })
      if (!path.startsWith('/api/')) {
        if (request.method !== 'GET' || !options.dist) throw new HttpError(404, '页面不存在。')
        const root = resolve(options.dist)
        let decoded: string
        try {
          decoded = decodeURIComponent(path)
        } catch {
          throw new HttpError(404, '页面不存在。')
        }
        const target = resolve(root, '.' + decoded)
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
      if (path === '/api/models' && request.method === 'GET')
        return json(response, 200, modelCatalog(!!agents.options.adapter))
      if (path === '/api/library' || path.startsWith('/api/library/passages/')) {
        if (request.method !== 'GET') throw new HttpError(405, '不支持该操作。')
        const library = options.library
        if (!library) throw new HttpError(503, '文献库尚未配置。')
        if (path === '/api/library') {
          for (const key of ['limit', 'offset']) {
            const values = url.searchParams.getAll(key)
            if (values.length > 1 || (values.length === 1 && !/^\d+$/.test(values[0])))
              throw new HttpError(400, '文献分页参数无效。')
          }
          const documents = library.list(
            Number(url.searchParams.get('limit') ?? 50),
            Number(url.searchParams.get('offset') ?? 0),
          )
          return json(response, 200, { total: library.count(), documents })
        }
        const passageId =
          /^\/api\/library\/passages\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(path)
        if (!passageId) throw new HttpError(400, '原文片段编号无效。')
        const formats = url.searchParams.getAll('format')
        if (formats.length > 1 || (formats.length === 1 && formats[0] !== 'json'))
          throw new HttpError(400, '原文片段格式无效。')
        const passage = library.passage(passageId[1].toLowerCase())
        if (formats[0] === 'json') return json(response, 200, passage)
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
        return response.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${escapeHtml(passage.title)} · 原文片段</title>
<style>pre{white-space:pre-wrap;overflow-wrap:anywhere}a,code,h1,dd{overflow-wrap:anywhere}</style></head>
<body><main><h1>${escapeHtml(passage.title)}</h1><dl>
<dt>章节</dt><dd>${escapeHtml(passage.heading || '未标注章节')}</dd>
<dt>文献版本</dt><dd><code>${escapeHtml(passage.versionId)}</code></dd>
<dt>发布日期</dt><dd>${escapeHtml(passage.publishedAt || '未提供')}</dd>
<dt>原始来源</dt><dd>${passage.sourceUrl ? `<a href="${escapeHtml(passage.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(passage.sourceUrl)}</a>` : '未提供'}</dd>
</dl><h2>原文片段</h2><pre>${escapeHtml(passage.text)}</pre></main></body></html>`)
      }
      if (path === '/api/sessions') {
        if (request.method === 'GET') return json(response, 200, store.list(user.id))
        if (request.method === 'POST') return json(response, 201, store.create(user.id))
      }
      const file = /^\/api\/files\/([0-9a-f-]{36})$/.exec(path)
      if (file && request.method === 'GET') {
        const artifact = store.artifact(user.id, file[1])
        const data = await readFile(agents.files.path(artifact.id))
        response.writeHead(200, {
          'Content-Type': MIME[artifact.format] ?? 'application/octet-stream',
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
        const selection = 'selection' in input ? validateSelection(input.selection) : undefined
        await agents.start(user.id, id, input.question.trim(), selection)
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
        let previous: Session | undefined
        let batch: ReturnType<typeof setTimeout> | undefined
        const send = async () => {
          if (writing || closed) return
          writing = true
          dirty = false
          try {
            const view = await agents.snapshot(user.id, id)
            if (!closed) {
              const frame: SessionFrame = previous
                ? { changes: sessionChanges(previous, view) }
                : { snapshot: view }
              previous = view
              if (!response.write(`data: ${JSON.stringify(frame)}\n\n`))
                await new Promise<void>((done) => {
                  const finish = () => {
                    response.off('drain', finish)
                    response.off('close', finish)
                    done()
                  }
                  response.once('drain', finish)
                  response.once('close', finish)
                })
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
          if (!batch && !closed && !writing)
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
