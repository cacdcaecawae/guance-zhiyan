// Explicit Qdrant acceptance test; never loads server/.env or silently skips.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LibraryStore } from '../rag-store.ts'
import { KnowledgeLibrary } from '../rag.ts'
import { Store } from '../store.ts'

test(
  'real Qdrant: import, search, update, historical sources, deletion and failed reindex recovery',
  { timeout: 90_000 },
  async (t) => {
    const endpoint = new URL(process.env.RAG_TEST_QDRANT_URL ?? 'http://127.0.0.1:6333')
    assert.ok(
      ['http:', 'https:'].includes(endpoint.protocol) &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash,
      'RAG_TEST_QDRANT_URL must be a loopback HTTP(S) endpoint without credentials.',
    )
    const root = await mkdtemp(join(tmpdir(), 'gczy-live-rag-'))
    const store = new Store(join(root, 'data'))
    const model = `synthetic-rag-smoke-${randomUUID()}`
    let failHousing = false
    const batches: number[] = []
    const embedding = createServer(async (request, response) => {
      assert.equal(request.url, '/embeddings')
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.authorization, undefined)
      const buffers: Buffer[] = []
      for await (const buffer of request) buffers.push(buffer)
      const body = JSON.parse(Buffer.concat(buffers).toString())
      assert.equal(body.model, model)
      assert.equal(body.dimensions, 2)
      assert.ok(Array.isArray(body.input) && body.input.length <= 16)
      batches.push(body.input.length)
      if (failHousing && body.input.some((text: string) => text.includes('住房'))) {
        response.writeHead(503)
        response.end('synthetic upstream body must not reach CLI errors')
        return
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          data: body.input
            .map((text: string, index: number) => ({
              index,
              embedding: text.includes('住房') ? [0, 1] : [1, 0],
            }))
            .reverse(),
        }),
      )
    })
    let collectionURL: string | undefined
    let ownsCollection = false
    const admin = (method: string) =>
      fetch(collectionURL!, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
    t.after(async () => {
      try {
        if (ownsCollection) {
          const removed = await admin('DELETE')
          await removed.body?.cancel()
          assert.ok(
            removed.ok || removed.status === 404,
            'remove only the collection minted by this test',
          )
          const missing = await admin('GET')
          await missing.body?.cancel()
          assert.equal(missing.status, 404, 'the temporary collection must be gone')
        }
      } finally {
        embedding.closeAllConnections()
        await new Promise<void>((done) => embedding.close(() => done()))
        store.close()
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
        assert.ok(basename(root).startsWith('gczy-live-rag-'))
        await rm(root, { recursive: true })
      }
    })
    embedding.listen(0, '127.0.0.1')
    await once(embedding, 'listening')
    const address = embedding.address()
    assert.ok(address && typeof address !== 'string')
    const config = {
      embedding: { url: `http://127.0.0.1:${address.port}/embeddings`, model, dimensions: 2 },
      qdrant: { url: endpoint.href },
    }
    const documents = new LibraryStore(store)
    const library = new KnowledgeLibrary(documents, config)
    const vectors = library.vectors!
    const collection = `rag_v1_${library.embeddings!.fingerprint}`
    collectionURL = `${endpoint.href.replace(/\/+$/, '')}/collections/${collection}`
    const absent = await admin('GET')
    await absent.body?.cancel()
    assert.equal(absent.status, 404, 'a unique test collection must not exist before the test')
    ownsCollection = true
    t.diagnostic(
      `Temporary collection: ${collection}; embedding uses synthetic two-dimensional vectors.`,
    )

    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          /^(path|systemroot|windir|temp|tmp|tmpdir|home|userprofile|localappdata|appdata)$/i.test(
            name,
          ),
        ),
      ),
      DATA_DIR: store.root,
      EMBEDDING_URL: config.embedding.url,
      EMBEDDING_MODEL: model,
      EMBEDDING_DIMENSIONS: '2',
      QDRANT_URL: endpoint.href,
    }
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
        execFile(
          process.execPath,
          [fileURLToPath(new URL('../rag-import.ts', import.meta.url)), ...args],
          { cwd: root, env, timeout: 30_000, windowsHide: true },
          (error, stdout, stderr) => {
            const code = error ? error.code : 0
            if (typeof code !== 'number') reject(error)
            else done({ code, stdout, stderr })
          },
        )
      })
    const pension = {
      id: 'a-synthetic-pension',
      title: '养老自动化测试文献（非真实政策）',
      text: Array.from(
        { length: 18 },
        (_, index) => `第${index + 1}条 养老测试原文，保留空格  和字符😀。`,
      ).join('\r\n'),
      sourceUrl: 'https://example.org/synthetic-pension',
      publishedAt: '2024-02-29',
    }
    const housing = {
      id: 'z-synthetic-housing',
      title: '住房自动化测试文献（非真实政策）',
      text: '第一条 住房测试原文，不是真实政策。',
    }
    const input = join(root, 'synthetic.jsonl')
    await writeFile(
      input,
      '\ufeff' + [pension, housing].map((row) => JSON.stringify(row)).join('\r\n'),
    )
    const imported = await run(['import', input])
    assert.equal(imported.code, 0, imported.stderr)
    assert.match(imported.stdout, /任务完成，共处理 2 篇文献/)
    assert.deepEqual(batches, [16, 2, 1])
    assert.equal(await vectors.ensureCollection(), false)
    const oldVersion = documents.current(pension.id)!
    const oldChunks = documents.chunks(oldVersion)
    assert.equal(
      store.db.prepare('SELECT text FROM rag_versions WHERE id=?').get(oldVersion)!.text,
      pension.text,
    )
    for (const passage of oldChunks) {
      assert.equal(passage.text, pension.text.slice(passage.start, passage.end))
      assert.equal(passage.sourceUrl, pension.sourceUrl)
      assert.equal(passage.publishedAt, pension.publishedAt)
    }
    const hits = await vectors.search([1, 0], 80)
    assert.equal(hits.length, 19)
    assert.ok(hits[0].score > 0.999)
    assert.equal(documents.passage(hits[0].id).documentId, pension.id)
    assert.equal((await vectors.search([1, 0], 2)).length, 2)
    assert.deepEqual(await vectors.search([1, 0], 80, undefined, 19), [])
    assert.equal((await library.retrieve('养老'))[0].documentId, pension.id)

    const changed = { ...pension, text: '第一条 养老修订测试原文，历史引用仍能读取。' }
    const updated = await library.import(changed)
    assert.notEqual(updated.versionId, oldVersion)
    const current = documents.chunks(updated.versionId)[0]
    assert.equal(documents.passage(oldChunks[0].id).text, oldChunks[0].text)
    assert.equal(documents.passage(current.id).text, changed.text)
    assert.equal((await library.retrieve('养老'))[0].id, current.id)
    assert.equal(
      (await vectors.search([1, 0], 80)).length,
      2,
      'old vectors must be removed after publication',
    )
    await vectors.delete([current.id])
    assert.ok((await vectors.search([1, 0], 80)).every((hit) => hit.id !== current.id))
    assert.equal(
      documents.passage(current.id).text,
      changed.text,
      'deleting an index point must not remove original text',
    )
    assert.equal((await library.import(changed)).versionId, updated.versionId)
    assert.equal((await vectors.search([1, 0], 80)).length, 2)

    // A lost collection must fail explicitly, then rebuild from SQLite's immutable source versions.
    const deleted = await admin('DELETE')
    await deleted.body?.cancel()
    assert.equal(deleted.status, 200)
    await assert.rejects(library.retrieve('养老'), { code: 'RAG_RETRIEVAL_FAILED' })
    const versions = documents.list()
    failHousing = true
    const failed = await run(['reindex'])
    assert.equal(failed.code, 1)
    assert.match(failed.stderr, /向量服务请求失败（HTTP 503）/)
    assert.doesNotMatch(failed.stderr, /synthetic upstream body/)
    assert.doesNotMatch(failed.stdout, /任务完成/)
    await assert.rejects(readFile(join(store.root, 'rag-import.lock')), { code: 'ENOENT' })
    assert.deepEqual(documents.list(), versions)
    await assert.rejects(library.retrieve('养老'), { code: 'RAG_NOT_INDEXED' })
    failHousing = false
    const rebuilt = await run(['reindex'])
    assert.equal(rebuilt.code, 0, rebuilt.stderr)
    assert.match(rebuilt.stdout, /任务完成，共处理 2 篇文献/)
    await assert.rejects(readFile(join(store.root, 'rag-import.lock')), { code: 'ENOENT' })
    assert.deepEqual(documents.list(), versions)
    assert.equal((await vectors.search([1, 0], 80)).length, 2)
    assert.equal((await library.retrieve('养老'))[0].id, current.id)
    assert.equal(documents.passage(oldChunks[0].id).text, oldChunks[0].text)
  },
)
