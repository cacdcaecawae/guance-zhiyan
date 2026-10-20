import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { RagError } from './rag.ts'
import { LibraryStore, type Passage } from './rag-store.ts'
import { Store } from './store.ts'

test('library HTTP requires identity, publishes real pages safely and retains historical citations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-rag-http-test-'))
  const store = new Store(root)
  const library = new LibraryStore(store)
  const agents = new Agents(store)
  const options = {
    library: library as LibraryStore | undefined,
    search: undefined as ((query: string, signal: AbortSignal) => Promise<Passage[]>) | undefined,
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
    // Title search keeps the same shape; the total counts the matches only.
    // Every space-separated word must appear in the title.
    // However many words there are, each counts: the first eight below all appear in the title.
    const nine = '测试 img src x onerror alert 1 ( 无关'
    for (const [query, total] of [
      [' 测试 ', 1],
      ['测试 img', 1],
      ['测试 无关', 0],
      [nine, 0],
      [nine.replace(' 无关', ''), 1],
    ] as const)
      assert.equal(
        (await (await get('/api/library?q=' + encodeURIComponent(query))).json()).total,
        total,
        query,
      )
    // Title and content search accept the same length, so switching modes keeps a valid query.
    assert.equal((await get('/api/library?q=' + 'x'.repeat(500))).status, 200)
    assert.deepEqual(await (await get('/api/library?q=%E6%97%A0%E5%85%B3')).json(), {
      total: 0,
      documents: [],
    })
    const read = await (await get(`/api/library/document?id=${document.id}`)).json()
    assert.deepEqual(
      { ...read, passages: read.passages.map((passage: { id: string }) => passage.id) },
      {
        id: document.id,
        versionId: first.versionId,
        title: document.title,
        sourceUrl: document.sourceUrl,
        publishedAt: document.publishedAt,
        passages: first.chunks.map((chunk) => chunk.id),
      },
    )
    assert.equal(read.passages[0].text, first.chunks[0].text)
    assert.equal((await get('/api/library/document?id=missing')).status, 404)
    for (const query of ['', '?id=', '?id=a&id=b', '?id=' + 'x'.repeat(257)])
      assert.equal((await get('/api/library/document' + query)).status, 400, query)
    assert.equal((await fetch(base + `/api/library/document?id=${document.id}`)).status, 401)

    // Content search runs the configured retrieval and returns the passages it ranked.
    const search = '/api/library/search?q='
    const unconfigured = await get(search + 'x')
    assert.equal(unconfigured.status, 503)
    assert.match((await unconfigured.json()).error, /向量服务/)
    const queries: string[] = []
    options.search = async (query) => {
      queries.push(query)
      return first.chunks
    }
    assert.equal((await fetch(base + search + 'x')).status, 401)
    const found = await (await get(search + encodeURIComponent(' 测试 原文 '))).json()
    assert.deepEqual(queries, ['测试 原文'])
    assert.deepEqual(
      found.passages,
      first.chunks.map(({ id, documentId, title, heading, text, ordinal }) => ({
        id,
        documentId,
        title,
        heading,
        text,
        ordinal,
      })),
    )
    for (const query of ['', '?q=', '?q=%20', '?q=a&q=b', '?q=' + 'x'.repeat(501)])
      assert.equal((await get('/api/library/search' + query)).status, 400, query)
    options.search = async () => {
      throw new RagError('RAG_NOT_INDEXED')
    }
    const failed = await get(search + 'x')
    assert.equal(failed.status, 503)
    assert.match((await failed.json()).error, /索引尚未完成/)
    options.search = undefined
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
    assert.ok(html.includes('<dt>版本状态</dt><dd>现行版本</dd>'))
    assert.ok(html.includes('2024-02-29'))
    assert.doesNotMatch(html, /<(?:script|img|svg)\b/)
    assert.deepEqual(await (await get(path + '?format=json')).json(), {
      ...first.chunks[0],
      superseded: false,
    })
    assert.equal((await fetch(base + path, { headers: { 'x-test-user': 'bob' } })).status, 200)

    const replacement = library.stage({ ...document, text: '第一条 更新后的自动化测试原文。' })
    library.publish(replacement.versionId, first.versionId)
    assert.deepEqual(await (await get(path + '?format=json')).json(), {
      ...first.chunks[0],
      superseded: true,
    })
    const replaced = await (await get(path)).text()
    assert.ok(replaced.includes(first.versionId))
    assert.ok(replaced.includes('<dd><strong>已被新版本替代</strong>；此处为旧版本原文'))
    assert.ok((await (await get('/api/library')).text()).includes(replacement.versionId))
    const updated = await (await get(`/api/library/document?id=${document.id}`)).json()
    assert.equal(updated.versionId, replacement.versionId)
    assert.equal(updated.passages[0].id, replacement.chunks[0].id)
    const draft = library.stage({ ...document, id: 'never-published' })
    assert.equal((await get(`/api/library/passages/${draft.chunks[0].id}`)).status, 404)
    assert.equal((await get('/api/library/document?id=never-published')).status, 404)
    // Ids are free text: ones a path would normalize or misread still open exactly.
    for (const id of ['.', '..', 'a/b', 'a%2Fb', '#?&=', 'policy-2026.10', ' 空 格 ']) {
      const staged = library.stage({ id, title: '特殊编号', text: `编号 ${id} 的原文。` })
      library.publish(staged.versionId, null)
      const opened = await get('/api/library/document?' + new URLSearchParams({ id }))
      assert.equal((await opened.json()).id, id, id)
    }

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
      '?q=a&q=b',
      '?q=' + 'x'.repeat(501),
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

test('library pages load the app on refresh; missing assets stay 404', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-rag-http-test-'))
  const dist = join(root, 'dist')
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>app</title>')
  const store = new Store(join(root, 'data'))
  const agents = new Agents(store)
  const server = createApp(store, agents, { dist })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    // A dotted document id stays in the query, so the page path never looks like a file.
    for (const path of ['/library/document?id=policy-2026.10', '/library?q=a.b', '/library'])
      assert.equal(
        await (await fetch(base + path)).text(),
        '<!doctype html><title>app</title>',
        path,
      )
    for (const path of ['/assets/missing.js', '/favicon.ico'])
      assert.equal((await fetch(base + path)).status, 404, path)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await agents.close()
    store.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true })
  }
})
