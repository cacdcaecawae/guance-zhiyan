import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readDocuments } from './rag-import.ts'
import { LibraryStore, type DocumentInput } from './rag-store.ts'
import { KnowledgeLibrary, ragConfig } from './rag.ts'
import { Store } from './store.ts'

type Operation = 'embed' | 'ensure' | 'create' | 'upsert' | 'delete' | 'query'
type Point = { id: string; vector: number[]; payload: { documentId: string; versionId: string } }
const gate = (operation: Operation, after = 0) => ({
  operation,
  after,
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
})

async function removeTestRoot(root: string) {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  assert.ok(basename(root).startsWith('gczy-rag-integration-'))
  await rm(root, { recursive: true })
}

async function backend(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'gczy-rag-integration-'))
  const store = new Store(root)
  const documents = new LibraryStore(store)
  const calls: { operation: Operation; body: Record<string, unknown> }[] = []
  const control = {
    collections: new Map<string, Map<string, Point>>(),
    dense: undefined as string[] | undefined,
    fail: undefined as Operation | undefined,
    failAfter: 0,
    gate: undefined as ReturnType<typeof gate> | undefined,
  }
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    const buffers: Buffer[] = []
    for await (const buffer of request) buffers.push(buffer)
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : {}
    const match = /^(.*\/collections\/[^/]+)(\/points(?:\/(?:query|delete))?)?$/.exec(path)
    const operation: Operation =
      path === '/embeddings'
        ? 'embed'
        : match?.[2] === '/points/query'
          ? 'query'
          : match?.[2] === '/points/delete'
            ? 'delete'
            : match?.[2] === '/points'
              ? 'upsert'
              : request.method === 'GET'
                ? 'ensure'
                : 'create'
    calls.push({ operation, body })
    const waiting = control.gate
    if (waiting?.operation === operation && waiting.after-- === 0) {
      waiting.entered.resolve()
      await waiting.release.promise
    }
    if (response.destroyed) return
    if (control.fail === operation && control.failAfter-- <= 0) {
      response.writeHead(503)
      response.end('test-only upstream failure')
      return
    }
    if (operation === 'embed') {
      response.end(
        JSON.stringify({
          data: (body.input as string[]).map((_, index) => ({ index, embedding: [1, index + 1] })),
        }),
      )
      return
    }
    assert.ok(match, 'unexpected vector endpoint')
    const key = match[1]
    const reply = (result: unknown) => response.end(JSON.stringify({ status: 'ok', result }))
    if (operation === 'create') {
      control.collections.set(key, new Map())
      reply(true)
      return
    }
    const points = control.collections.get(key)
    if (!points) {
      response.writeHead(404)
      response.end()
      return
    }
    if (operation === 'ensure')
      reply({ config: { params: { vectors: { size: 2, distance: 'Cosine' } } } })
    else if (operation === 'upsert') {
      for (const point of body.points as Point[]) points.set(point.id, point)
      reply({ status: 'completed' })
    } else if (operation === 'delete') {
      for (const id of body.points as string[]) points.delete(id)
      reply({ status: 'completed' })
    } else
      reply({
        points: (control.dense ?? [...points.keys()])
          .slice(body.offset ?? 0, (body.offset ?? 0) + body.limit)
          .map((id, index) => ({ id, score: 1 / ((body.offset ?? 0) + index + 1) })),
      })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    control.gate?.release.resolve()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    store.close()
    await removeTestRoot(root)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const config = {
    embedding: { url: url + '/embeddings', model: 'test-embedding', dimensions: 2 },
    qdrant: { url },
  }
  const library = new KnowledgeLibrary(documents, config)
  return {
    library,
    documents,
    store,
    config,
    control,
    calls,
    pointIds: () =>
      [...control.collections.values()].flatMap((points) => [...points.keys()]).sort(),
  }
}

test('imports publish only completed batches; failed updates keep old sources and retry with stable IDs', async (t) => {
  const { library, documents, store, control, calls, pointIds } = await backend(t)
  const input = {
    id: 'versioned-test',
    title: '测试版本文献',
    text: Array.from({ length: 18 }, (_, index) => `第${index + 1}条 初版测试内容。`).join('\n'),
  }
  const waiting = gate('upsert', 1)
  control.gate = waiting
  const importing = library.import(input)
  await waiting.entered.promise
  assert.equal(documents.current(input.id), null)
  assert.equal(documents.count(), 0)
  assert.equal(pointIds().length, 16, 'the first batch must not make the document visible')
  await assert.rejects(library.retrieve('测试'), { code: 'RAG_EMPTY' })
  waiting.release.resolve()
  control.gate = undefined
  const first = await importing
  assert.equal(first.chunks, 18)
  assert.equal(documents.current(input.id), first.versionId)
  assert.equal(pointIds().length, 18)
  assert.deepEqual(
    calls
      .filter((call) => call.operation === 'embed')
      .map((call) => (call.body.input as string[]).length),
    [16, 2],
  )
  const old = documents.chunks(first.versionId)
  const changed = { ...input, text: input.text.replaceAll('初版', '更新') }
  const staged = documents.stage(changed)
  const indexed = () =>
    store.db
      .prepare('SELECT 1 FROM rag_indexed_versions WHERE fingerprint=? AND version_id=?')
      .get(library.indexFingerprint!, staged.versionId)

  control.fail = 'embed'
  await assert.rejects(library.import(changed), /向量服务请求失败/)
  assert.equal(documents.current(input.id), first.versionId)
  assert.equal(indexed(), undefined)
  assert.equal(pointIds().length, 18)
  control.fail = 'upsert'
  control.failAfter = 1
  await assert.rejects(library.import(changed), /Qdrant 请求失败/)
  assert.equal(documents.current(input.id), first.versionId)
  assert.equal(indexed(), undefined)
  assert.equal(pointIds().length, 34, 'a failed second batch leaves only unpublished draft vectors')
  assert.throws(() => documents.passage(staged.chunks[0].id), { status: 404 })

  // Cleanup occurs after publication; retrying must finish cleanup without changing citation IDs.
  control.fail = 'delete'
  control.failAfter = 0
  await assert.rejects(library.import(changed), /Qdrant 请求失败/)
  assert.equal(documents.current(input.id), staged.versionId)
  assert.equal(pointIds().length, 36)
  control.fail = undefined
  const retried = await library.import(changed)
  assert.equal(retried.versionId, staged.versionId)
  assert.deepEqual(pointIds(), staged.chunks.map((chunk) => chunk.id).sort())
  assert.ok(indexed())
  assert.equal(documents.passage(old[0].id).text, old[0].text)
  assert.deepEqual(
    calls.filter((call) => call.operation === 'delete').at(-1)!.body.points,
    old.map((chunk) => chunk.id),
  )
})

test('retrieval fuses lexical and dense rankings, filters stale versions, and never substitutes results on failure or abort', async (t) => {
  const { library, documents, control, calls } = await backend(t)
  const dense = await library.import({
    id: 'dense',
    title: '基础设施测试',
    text: '第一条 建设施工测试。',
  })
  const old = await library.import({ id: 'both', title: '养老测试', text: '第一条 养老原版测试。' })
  const both = await library.import({
    id: 'both',
    title: '养老测试',
    text: '第一条 养老新版测试。',
  })
  const lexical = await library.import({
    id: 'lexical',
    title: '养老服务测试',
    text: '第一条 养老支持测试。',
  })
  const draft = documents.stage({
    id: 'draft',
    title: '未发布测试',
    text: '第一条 养老未发布测试。',
  })
  const denseId = documents.chunks(dense.versionId)[0].id
  const oldId = documents.chunks(old.versionId)[0].id
  const bothId = documents.chunks(both.versionId)[0].id
  const lexicalId = documents.chunks(lexical.versionId)[0].id
  control.dense = [denseId, oldId, bothId, draft.chunks[0].id, randomUUID()]
  const results = await library.retrieve('养老')
  assert.equal(
    results[0].id,
    bothId,
    'appearing in both rankings outranks a dense-only first place',
  )
  assert.deepEqual(results.map((passage) => passage.id).sort(), [denseId, bothId, lexicalId].sort())
  assert.ok(results.every((passage) => passage.text === documents.passage(passage.id).text))
  assert.equal(calls.filter((call) => call.operation === 'query').at(-1)!.body.limit, 80)

  control.dense = []
  assert.deepEqual(await library.retrieve('unmatchedtestword'), [])
  for (const operation of ['embed', 'query'] as const) {
    control.fail = operation
    control.failAfter = 0
    await assert.rejects(library.retrieve('养老'), { code: 'RAG_RETRIEVAL_FAILED' })
  }
  control.fail = undefined
  const before = calls.length
  await assert.rejects(library.retrieve('养老', AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(calls.length, before)
  const waiting = gate('query')
  control.gate = waiting
  const controller = new AbortController()
  const pending = library.retrieve('养老', controller.signal)
  await waiting.entered.promise
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  waiting.release.resolve()
  control.gate = undefined
})

test('a full page of unpublished vectors cannot hide the current source; the next successful version cleans failed drafts', async (t) => {
  const { library, documents, control, calls, pointIds } = await backend(t)
  const input = { id: 'failed-update', title: '分页回归测试', text: '第一条 当前有效原文。' }
  const original = await library.import(input)
  const oldId = documents.chunks(original.versionId)[0].id
  const changed = {
    ...input,
    text: Array.from({ length: 96 }, (_, index) => `第${index + 1}条 未发布测试内容。`).join('\n'),
  }
  const draft = documents.stage(changed)
  control.fail = 'upsert'
  control.failAfter = 5
  await assert.rejects(library.import(changed), /Qdrant 请求失败/)
  assert.equal(pointIds().length, 81)
  assert.equal(documents.current(input.id), original.versionId)
  control.fail = undefined
  control.dense = [...draft.chunks.slice(0, 80).map((chunk) => chunk.id), oldId]
  assert.deepEqual(
    (await library.retrieve('unmatchedtestword')).map((passage) => passage.id),
    [oldId],
  )
  assert.deepEqual(
    calls.filter((call) => call.operation === 'query').map((call) => call.body.offset),
    [0, 80],
  )

  const replacement = await library.import({ ...input, text: '第一条 修订成功的测试原文。' })
  const activeId = documents.chunks(replacement.versionId)[0].id
  assert.deepEqual(pointIds(), [activeId])
  const deleted = calls
    .filter((call) => call.operation === 'delete')
    .flatMap((call) => call.body.points as string[])
  assert.deepEqual(deleted.sort(), [oldId, ...draft.chunks.map((chunk) => chunk.id)].sort())
  assert.equal(documents.passage(oldId).text, input.text)
  assert.throws(() => documents.passage(draft.chunks[0].id), { status: 404 })
})

test('configuration errors are distinct; missing collections invalidate markers even if recreation verification fails', async (t) => {
  const { library, documents, store, config, control, calls } = await backend(t)
  assert.equal(ragConfig({}), undefined)
  assert.throws(() => ragConfig({ EMBEDDING_URL: 'http://localhost/embeddings' }), /同时配置/)
  const unconfigured = new KnowledgeLibrary(documents)
  await assert.rejects(unconfigured.retrieve('测试'), { code: 'RAG_NOT_CONFIGURED' })
  await assert.rejects(library.retrieve('测试'), { code: 'RAG_EMPTY' })
  const first = { id: 'first', title: '甲测试', text: '第一条 养老测试。' }
  const second = { id: 'second', title: '乙测试', text: '第一条 住房测试。' }
  const a = await library.import(first)
  await library.import(second)
  const before = calls.length
  for (const changed of [
    { ...config, embedding: { ...config.embedding, model: 'another-model' } },
    { ...config, qdrant: { url: config.qdrant.url + '/moved' } },
  ])
    await assert.rejects(new KnowledgeLibrary(documents, changed).retrieve('测试'), {
      code: 'RAG_NOT_INDEXED',
    })
  assert.equal(
    calls.length,
    before,
    'incomplete model/server indexes must fail before vector requests',
  )

  control.collections.clear()
  await assert.rejects(library.retrieve('测试'), { code: 'RAG_RETRIEVAL_FAILED' })
  const changed = { ...first, text: '第一条 更新后的养老测试。' }
  control.fail = 'ensure'
  control.failAfter = 1 // Initial GET returns 404; PUT succeeds, then its verification GET fails.
  await assert.rejects(library.import(changed), /Qdrant 请求失败/)
  assert.equal(control.collections.size, 1)
  assert.ok([...control.collections.values()].every((points) => points.size === 0))
  assert.equal(documents.current(first.id), a.versionId, 'failed setup must not publish the draft')
  assert.throws(() => documents.passage(documents.stage(changed).chunks[0].id), { status: 404 })
  assert.deepEqual(
    store.db
      .prepare('SELECT version_id FROM rag_indexed_versions WHERE fingerprint=?')
      .all(library.indexFingerprint!),
    [],
    'invalidation must commit before the external collection is created',
  )
  control.fail = undefined
  const rebuilt = await library.import(changed)
  assert.equal(documents.count(), 2)
  assert.deepEqual(
    store.db
      .prepare('SELECT version_id FROM rag_indexed_versions WHERE fingerprint=?')
      .all(library.indexFingerprint!)
      .map((row) => row.version_id),
    [rebuilt.versionId],
  )
  await assert.rejects(library.retrieve('测试'), { code: 'RAG_NOT_INDEXED' })
  await library.import(second)
  assert.equal((await library.retrieve('测试')).length, 2)
})

test('retrieval fails as not indexed when reindex starts during an external request', async (t) => {
  const { library, documents, store, control } = await backend(t)
  const first = { id: 'first', title: '并发重建甲', text: '第一条 养老测试。' }
  await library.import(first)
  await library.import({ id: 'second', title: '并发重建乙', text: '第一条 住房测试。' })
  const waiting = gate('embed')
  control.gate = waiting
  const retrieving = library.retrieve('测试')
  await waiting.entered.promise
  store.db
    .prepare('DELETE FROM rag_indexed_versions WHERE fingerprint=?')
    .run(library.indexFingerprint!)
  for (const points of control.collections.values()) points.clear()
  await library.import(first)
  assert.equal(documents.count(), 2)
  assert.equal(
    Number(store.db.prepare('SELECT count(*) AS n FROM rag_indexed_versions').get()!.n),
    1,
  )
  waiting.release.resolve()
  control.gate = undefined
  await assert.rejects(retrieving, { code: 'RAG_NOT_INDEXED' })
})

test('the actual import and reindex CLI persists sources, rebuilds markers and preserves an existing lock', async (t) => {
  const { documents, store, config, library, control, calls, pointIds } = await backend(t)
  const path = join(store.root, 'input.jsonl')
  const lockPath = join(store.root, 'rag-import.lock')
  const inputs = [
    {
      id: 'z-test',
      title: 'CLI 测试甲',
      text: '第一条 导入命令测试。',
      sourceUrl: 'https://example.org/policy',
      publishedAt: '2024-02-29',
    },
    { id: 'a-test', title: 'CLI 测试乙', text: '第一条 重建命令测试。' },
  ]
  await writeFile(path, inputs.map((input) => JSON.stringify(input)).join('\n'))
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
    EMBEDDING_MODEL: config.embedding.model,
    EMBEDDING_DIMENSIONS: String(config.embedding.dimensions),
    QDRANT_URL: config.qdrant.url,
  }
  const run = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
      execFile(
        process.execPath,
        [fileURLToPath(new URL('./rag-import.ts', import.meta.url)), ...args],
        { cwd: store.root, env, timeout: 15_000, windowsHide: true },
        (error, stdout, stderr) => {
          const code = error ? error.code : 0
          if (typeof code !== 'number') reject(error)
          else done({ code, stdout, stderr })
        },
      )
    })
  const markers = () =>
    Number(
      store.db
        .prepare('SELECT count(*) AS count FROM rag_indexed_versions WHERE fingerprint=?')
        .get(library.indexFingerprint!)!.count,
    )
  const imported = await run(['import', path])
  assert.equal(imported.code, 0, imported.stderr)
  assert.match(imported.stdout, /任务完成，共处理 2 篇文献/)
  assert.equal(documents.count(), 2)
  assert.equal(markers(), 2)
  const sources = documents.list()
  const ids = pointIds()
  assert.equal(ids.length, 2)
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' })

  const waiting = gate('upsert')
  control.gate = waiting
  const rebuilding = run(['reindex'])
  await waiting.entered.promise
  assert.equal(markers(), 0, 'reindex clears completion markers before rebuilding any document')
  assert.equal(documents.count(), 2)
  waiting.release.resolve()
  control.gate = undefined
  const rebuilt = await rebuilding
  assert.equal(rebuilt.code, 0, rebuilt.stderr)
  assert.match(rebuilt.stdout, /已重建 2 篇/)
  assert.match(rebuilt.stdout, /任务完成，共处理 2 篇文献/)
  assert.equal(markers(), 2)
  assert.deepEqual(documents.list(), sources)
  assert.deepEqual(pointIds(), ids)
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' })

  await writeFile(lockPath, 'another-import-test-owner', { flag: 'wx' })
  const before = calls.length
  const blocked = await run(['import', path])
  assert.equal(blocked.code, 1)
  assert.match(blocked.stderr, /已有导入任务或遗留 rag-import.lock/)
  assert.doesNotMatch(blocked.stdout, /任务完成/)
  assert.equal(await readFile(lockPath, 'utf8'), 'another-import-test-owner')
  assert.equal(calls.length, before)
  assert.equal(markers(), 2)
  assert.deepEqual(documents.list(), sources)
})

test('JSONL keeps UTF-8 text across stream boundaries and identifies invalid data by source line', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-rag-integration-'))
  t.after(() => removeTestRoot(root))
  const path = join(root, 'documents.jsonl')
  const collect = async (signal?: AbortSignal) => {
    const rows: DocumentInput[] = []
    for await (const row of readDocuments(path, signal)) rows.push(row)
    return rows
  }
  const first = { id: 'first', title: 'UTF-8 测试', text: '原文\r\n不改写。' }
  const last = { id: 'last', title: '长文本测试', text: '原文😀'.repeat(20_000) }
  await writeFile(path, '\ufeff' + JSON.stringify(first) + '\r\n\n' + JSON.stringify(last))
  assert.deepEqual(await collect(), [first, last])
  for (const invalid of [
    Buffer.from('{bad-json}'),
    Buffer.from('{"id":"missing-fields"}'),
    Buffer.concat([
      Buffer.from('{"id":"bad","title":"UTF-8","text":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}'),
    ]),
    Buffer.from('{"id":"bad","title":"Unicode","text":"\\ud800"}'),
  ]) {
    await writeFile(
      path,
      Buffer.concat([Buffer.from('\n' + JSON.stringify(first) + '\n'), invalid]),
    )
    const reader = readDocuments(path)
    assert.deepEqual((await reader.next()).value, first)
    await assert.rejects(reader.next(), /第 3 行不是有效 UTF-8 文献 JSON/)
  }
  await writeFile(path, ' \t\r\n\n')
  assert.deepEqual(await collect(), [])
  await assert.rejects(collect(AbortSignal.abort()), { name: 'AbortError' })
})
