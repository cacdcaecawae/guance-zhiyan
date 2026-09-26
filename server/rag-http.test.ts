import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { LibraryStore } from './rag-store.ts'
import { Store } from './store.ts'

test('library HTTP requires identity, publishes real pages safely and retains historical citations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-rag-http-test-'))
  const store = new Store(root)
  const library = new LibraryStore(store)
  const agents = new Agents(store)
  const options = {
    library: library as LibraryStore | undefined,
    authenticate: async (request: import('node:http').IncomingMessage) =>
      typeof request.headers['x-test-user'] === 'string'
        ? { subject: request.headers['x-test-user'], name: 'Test' }
        : undefined,
  }
  const server = createApp(store, agents, options)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const headers = { 'x-test-user': 'alice' }
  const get = (path: string) => fetch(base + path, { headers })
  try {
    assert.equal((await fetch(base + '/api/library')).status, 401)
    assert.deepEqual(await (await get('/api/library')).json(), { total: 0, documents: [] })
    const document = {
      id: 'test-policy',
      title: '测试 & <img src=x onerror="alert(1)">',
      text: '## 测试 <svg onload="alert(1)">\r\n原文 <script>alert(1)</script> & "引用"。',
      sourceUrl: "https://example.org/policy?q=\"<script>&x='test'",
      publishedAt: '2024-02-29',
    }
    const first = library.stage(document)
    const path = `/api/library/passages/${first.chunks[0].id}`
    assert.equal((await fetch(base + path)).status, 401)
    assert.equal((await fetch(base + path + '?format=json')).status, 401)
    assert.equal((await get(path)).status, 404)
    assert.equal((await get(path + '?format=json')).status, 404)
    assert.deepEqual(await (await get('/api/library')).json(), { total: 0, documents: [] })
    library.publish(first.versionId, null)

    assert.deepEqual(await (await get('/api/library?limit=1&offset=0')).json(), {
      total: 1,
      documents: [
        {
          id: document.id,
          versionId: first.versionId,
          title: document.title,
          sourceUrl: document.sourceUrl,
          publishedAt: document.publishedAt,
        },
      ],
    })
    assert.deepEqual(await (await get('/api/library?limit=1&offset=1')).json(), {
      total: 1,
      documents: [],
    })
    const response = await get(path)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/)
    assert.match(response.headers.get('content-security-policy')!, /script-src 'none'/)
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/)
    const html = await response.text()
    assert.match(html, /<html lang="zh-CN">/)
    assert.ok(html.includes('<h1>测试 &amp; &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</h1>'))
    assert.ok(html.includes('## 测试 &lt;svg onload=&quot;alert(1)&quot;&gt;'))
    assert.ok(html.includes('原文 &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;引用&quot;。'))
    assert.ok(
      html.includes('https://example.org/policy?q=&quot;&lt;script&gt;&amp;x=&#39;test&#39;'),
    )
    assert.ok(html.includes(first.versionId))
    assert.ok(html.includes('2024-02-29'))
    assert.doesNotMatch(html, /<(?:script|img|svg)\b/)
    assert.deepEqual(await (await get(path + '?format=json')).json(), { ...first.chunks[0] })
    assert.equal((await fetch(base + path, { headers: { 'x-test-user': 'bob' } })).status, 200)

    const replacement = library.stage({ ...document, text: '第一条 更新后的自动化测试原文。' })
    library.publish(replacement.versionId, first.versionId)
    assert.deepEqual(await (await get(path + '?format=json')).json(), { ...first.chunks[0] })
    assert.ok((await (await get(path)).text()).includes(first.versionId))
    assert.ok((await (await get('/api/library')).text()).includes(replacement.versionId))
    const draft = library.stage({ ...document, id: 'never-published' })
    assert.equal((await get(`/api/library/passages/${draft.chunks[0].id}`)).status, 404)

    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=1.5',
      '?limit=1e2',
      '?limit=',
      '?offset=-1',
      '?offset=NaN',
      '?offset=9007199254740992',
      '?offset=',
      '?limit=1&limit=2',
      '?offset=0&offset=1',
    ])
      assert.equal((await get('/api/library' + query)).status, 400, query)
    for (const query of ['?format=', '?format=html', '?format=xml', '?format=json&format=json'])
      assert.equal((await get(path + query)).status, 400, query)
    assert.equal((await get('/api/library/passages/not-a-uuid')).status, 400)
    assert.equal((await get(path + '/extra')).status, 400)
    assert.equal(
      (await get('/api/library/passages/00000000-0000-0000-0000-000000000000')).status,
      404,
    )
    assert.equal((await fetch(base + path, { method: 'POST', headers })).status, 405)
    options.library = undefined
    assert.equal((await get('/api/library')).status, 503)
    assert.equal((await get(path)).status, 503)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await agents.close()
    store.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    assert.ok(basename(root).startsWith('gczy-rag-http-test-'))
    await rm(root, { recursive: true })
  }
})
