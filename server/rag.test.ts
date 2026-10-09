import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readDocuments } from './rag-import.ts'
import { LibraryStore, type DocumentInput } from './rag-store.ts'
import { KnowledgeLibrary, ragConfig, type RagConfig } from './rag.ts'
import { Store } from './store.ts'

type Operation = 'embed' | 'ensure' | 'create' | 'index' | 'upsert' | 'delete' | 'query'
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
  const calls: { operation: Operation; body: Record<string, unknown>; path: string }[] = []
  const control = {
    collections: new Map<string, Map<string, Point>>(),
    dense: undefined as string[] | undefined,
    fail: undefined as Operation | undefined,
    failAfter: 0,
    gate: undefined as ReturnType<typeof gate> | undefined,
    embed: undefined as ((input: string, index: number) => number[]) | undefined,
    rankVectors: false,
  }
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    const buffers: Buffer[] = []
    for await (const buffer of request) buffers.push(buffer)
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : {}
    const match = /^(.*\/collections\/[^/]+)(\/points(?:\/(?:query|delete))?|\/index)?$/.exec(path)
    const operation: Operation =
      path === '/embeddings'
        ? 'embed'
        : match?.[2] === '/index'
          ? 'index'
          : match?.[2] === '/points/query'
            ? 'query'
            : match?.[2] === '/points/delete'
              ? 'delete'
              : match?.[2] === '/points'
                ? 'upsert'
                : request.method === 'GET'
                  ? 'ensure'
                  : 'create'
    calls.push({ operation, body, path })
    // Snapshot before a gate so a held response can contain the previous model's vector.
    const encoded =
      operation === 'embed'
        ? (body.input as string[]).map((input, index) => ({
            index,
            embedding: control.embed?.(input, index) ?? [1, index + 1],
          }))
        : undefined
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
          data: encoded,
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
    // Mirrors Qdrant's documentId filter: only points of the listed documents are candidates.
    const allowed: string[] | undefined = body.filter?.must?.[0]?.match?.any
    const inScope = (id: string) =>
      !allowed || allowed.includes(points.get(id)?.payload.documentId ?? '')
    if (operation === 'ensure')
      reply({ config: { params: { vectors: { size: 2, distance: 'Cosine' } } } })
    else if (operation === 'index') reply({ status: 'completed' })
    else if (operation === 'upsert') {
      for (const point of body.points as Point[]) points.set(point.id, point)
      reply({ status: 'completed' })
    } else if (operation === 'delete') {
      for (const id of body.points as string[]) points.delete(id)
      reply({ status: 'completed' })
    } else
      reply({
        points: (
          control.dense ??
          (control.rankVectors
            ? [...points.values()]
                .sort((a, b) => {
                  const similarity = (vector: number[]) =>
                    vector.reduce((sum, value, index) => sum + value * body.query[index], 0) /
                    Math.hypot(...vector) /
                    Math.hypot(...body.query)
                  return similarity(b.vector) - similarity(a.vector)
                })
                .map((point) => point.id)
            : [...points.keys()])
        )
          .filter(inScope)
          .slice(0, body.limit)
          .map((id, index) => ({ id, score: 1 / (index + 1) })),
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

function runNode(root: string, config: RagConfig, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        /^(path|systemroot|windir|temp|tmp|tmpdir|home|userprofile|localappdata|appdata)$/i.test(
          name,
        ),
      ),
    ),
    DATA_DIR: root,
    EMBEDDING_URL: config.embedding.url,
    EMBEDDING_MODEL: config.embedding.model,
    EMBEDDING_DIMENSIONS: String(config.embedding.dimensions),
    QDRANT_URL: config.qdrant.url,
  }
  return new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    execFile(
      process.execPath,
      args,
      { cwd: root, env, timeout: 15_000, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? error.code : 0
        if (typeof code !== 'number') reject(error)
        else done({ code, stdout, stderr })
      },
    )
  })
}

const runCli = (root: string, config: RagConfig, args: string[]) =>
  runNode(root, config, [fileURLToPath(new URL('./rag-import.ts', import.meta.url)), ...args])

test('imports publish only completed batches; failed updates keep old sources and retry with stable IDs', async (t) => {
  const { library, documents, store, control, calls, pointIds } = await backend(t)
  const input = {
    id: 'versioned-test',
    title: '测试版本文献',
    // Each article is long enough to be its own chunk: 12 chunks, embedded as 10 + 2.
    text: Array.from(
      { length: 12 },
      (_, index) => `第${index + 1}条 ` + '初版测试内容。'.repeat(50),
    ).join('\n'),
  }
  const waiting = gate('upsert', 1)
  control.gate = waiting
  const importing = library.import(input)
  await waiting.entered.promise
  assert.equal(documents.current(input.id), null)
  assert.equal(documents.count(), 0)
  assert.equal(pointIds().length, 10, 'the first batch must not make the document visible')
  await assert.rejects(library.retrieve('测试'), { code: 'RAG_EMPTY' })
  waiting.release.resolve()
  control.gate = undefined
  const first = await importing
  assert.equal(first.chunks, 12)
  assert.equal(documents.current(input.id), first.versionId)
  assert.equal(pointIds().length, 12)
  assert.deepEqual(
    calls
      .filter((call) => call.operation === 'embed')
      .map((call) => (call.body.input as string[]).length),
    [10, 2],
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
  assert.equal(pointIds().length, 12)
  control.fail = 'upsert'
  control.failAfter = 1
  await assert.rejects(library.import(changed), /Qdrant 请求失败/)
  assert.equal(documents.current(input.id), first.versionId)
  assert.equal(indexed(), undefined)
  assert.equal(pointIds().length, 22, 'a failed second batch leaves only unpublished draft vectors')
  assert.throws(() => documents.passage(staged.chunks[0].id), { status: 404 })

  // Cleanup occurs after publication; retrying must finish cleanup without changing citation IDs.
  control.fail = 'delete'
  control.failAfter = 0
  await assert.rejects(library.import(changed), /Qdrant 请求失败/)
  assert.equal(documents.current(input.id), staged.versionId)
  assert.equal(pointIds().length, 24)
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

test('a metadata scope filters dense candidates in Qdrant and lexical candidates in SQLite', async (t) => {
  const { library, documents, control, calls } = await backend(t)
  for (const [id, title] of [
    ['county', '裕安区养老规划'],
    ['other', '其他地区养老规划'],
  ])
    await library.import({ id, title, text: `第一条 ${title}养老测试。` })
  const inScope = documents.chunks(documents.current('county')!)[0].id
  control.dense = [documents.chunks(documents.current('other')!)[0].id, inScope]
  await assert.rejects(library.retrieve('养老', undefined, { area: '裕安区' }), {
    code: 'RAG_NO_METADATA',
  })
  documents.saveMetadata([
    {
      id: 'county',
      area: ['全国', '安徽', '六安市', '裕安区'],
      level: '县',
      period: '十四五',
      year: null,
      docType: '规划文件',
      outline: false,
    },
    {
      id: 'other',
      area: ['全国', '海南'],
      level: '省',
      period: '十四五',
      year: null,
      docType: '规划文件',
      outline: false,
    },
  ])
  const results = await library.retrieve('养老', undefined, { area: '裕安区', period: '十四五' })
  assert.deepEqual(
    results.map((passage) => passage.documentId),
    ['county'],
    'neither dense nor lexical candidates leave the scope',
  )
  const query = calls.filter((call) => call.operation === 'query').at(-1)!
  assert.deepEqual(query.body.filter, { must: [{ key: 'documentId', match: { any: ['county'] } }] })

  const before = calls.length
  assert.deepEqual(await library.retrieve('养老', undefined, { area: '西藏' }), [])
  assert.equal(calls.length, before, 'an empty scope needs no embedding or vector query')
  assert.equal(
    (await library.retrieve('养老')).length,
    2,
    'unfiltered retrieval still covers the whole library',
  )
  assert.equal(library.list({ area: '安徽' }).total, 1)
})

test('the metadata CLI validates lines, stores rows and indexes documentId for existing collections', async (t) => {
  const { library, store, config, calls } = await backend(t)
  await library.import({ id: 'county', title: '裕安区规划', text: '第一条 自动化测试。' })
  const file = join(store.root, 'metadata.jsonl')
  await writeFile(
    file,
    [
      JSON.stringify({
        id: 'county',
        area: ['全国', '安徽', '六安市', '裕安区'],
        period: '十四五',
      }),
      '{"id": 1}',
      '',
    ].join('\n'),
  )
  const failed = await runCli(store.root, config, ['metadata', file])
  assert.equal(failed.code, 1)
  assert.match(failed.stderr, /第 2 行/)
  assert.throws(() => library.scope({ area: '裕安区' }), { code: 'RAG_NO_METADATA' })
  const indexes = () => calls.filter((call) => call.operation === 'index').length
  const before = indexes()
  const done = await runCli(store.root, config, ['metadata', file, '--skip-invalid'])
  assert.equal(done.code, 0, done.stderr)
  assert.match(done.stdout, /共 1 篇；另有 1 行无效数据被跳过/)
  assert.equal(indexes(), before + 1)
  assert.deepEqual(library.scope({ area: '裕安区', period: '十四五' }), ['county'])
})

test('a full page of unpublished vectors cannot hide the current source; the next successful version cleans failed drafts', async (t) => {
  const { library, documents, control, calls, pointIds } = await backend(t)
  const input = { id: 'failed-update', title: '分页回归测试', text: '第一条 当前有效原文。' }
  const original = await library.import(input)
  const oldId = documents.chunks(original.versionId)[0].id
  const changed = {
    ...input,
    text: Array.from(
      { length: 96 },
      (_, index) => `第${index + 1}条 ` + '未发布测试内容。'.repeat(40),
    ).join('\n'),
  }
  const draft = documents.stage(changed)
  control.fail = 'upsert'
  control.failAfter = 8
  await assert.rejects(library.import(changed), /Qdrant 请求失败/)
  assert.equal(pointIds().length, 81)
  assert.equal(documents.current(input.id), original.versionId)
  control.fail = undefined
  control.dense = [...draft.chunks.slice(0, 80).map((chunk) => chunk.id), oldId]
  assert.deepEqual(
    (await library.retrieve('unmatchedtestword')).map((passage) => passage.id),
    [oldId],
  )
  // A second, larger query from the top instead of paging: cleanup deleting points ahead of an
  // offset cannot make it skip current ones.
  assert.deepEqual(
    calls
      .filter((call) => call.operation === 'query')
      .map((call) => [call.body.limit, call.body.offset]),
    [
      [80, undefined],
      [1000, undefined],
    ],
  )
  control.dense = Array.from({ length: 1000 }, () => randomUUID())
  await assert.rejects(library.retrieve('unmatchedtestword'), { code: 'RAG_RETRIEVAL_FAILED' })
  control.dense = undefined

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

  // Another DATA_DIR on the same Qdrant and model gets its own collection, whose cleanup cannot
  // delete this library's points; reopening a DATA_DIR keeps its collection.
  const otherRoot = await mkdtemp(join(tmpdir(), 'gczy-rag-integration-'))
  const otherStore = new Store(otherRoot)
  try {
    const other = new KnowledgeLibrary(new LibraryStore(otherStore), config)
    assert.notEqual(other.vectors!.collection, library.vectors!.collection)
    assert.notEqual(other.indexFingerprint, library.indexFingerprint)
  } finally {
    otherStore.close()
    await removeTestRoot(otherRoot)
  }
  const reopened = new KnowledgeLibrary(documents, config)
  assert.equal(reopened.vectors!.collection, library.vectors!.collection)
  assert.equal(reopened.indexFingerprint, library.indexFingerprint)
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

test('a complete CLI force rebuild rejects in-flight embeddings, vector results and lexical results across processes', async (t) => {
  const { documents, store, config, control, calls } = await backend(t)
  const prefixed = { ...config, qdrant: { url: config.qdrant.url + '/proxy/' } }
  const library = new KnowledgeLibrary(documents, prefixed)
  let revision = 0
  control.embed = (input) =>
    input.includes('needle') || input.includes('relevant')
      ? [revision % 2 === 0 ? 1 : -1, 0]
      : [0, 1]
  control.rankVectors = true
  for (let index = 0; index < 9; index++)
    await library.import({
      id: String(index),
      title: index === 8 ? 'relevant' : 'other',
      text: `Synthetic document content ${index}`,
    })
  const sources = documents.list()
  const oldPassage = documents.chunks(documents.current('8')!)[0]
  const lexical = documents.lexical.bind(documents)
  for (const phase of ['embed', 'query', 'query-fallback', 'lexical'] as const) {
    assert.equal((await library.retrieve('needle'))[0].documentId, '8')
    const waiting = gate(phase === 'embed' ? 'embed' : 'query', phase === 'query-fallback' ? 1 : 0)
    if (phase === 'query-fallback')
      control.dense = [...Array.from({ length: 80 }, () => randomUUID()), oldPassage.id]
    if (phase === 'lexical')
      documents.lexical = async (...args) => {
        const results = await lexical(...args)
        waiting.entered.resolve()
        await waiting.release.promise
        return results
      }
    else control.gate = waiting
    const rejected = assert.rejects(library.retrieve('needle'), { code: 'RAG_NOT_INDEXED' })
    try {
      await waiting.entered.promise
      const before = calls.filter((call) => call.operation === 'query').length
      revision++ // Same configured model name, incompatible replacement weights.
      const forced = await runCli(
        store.root,
        { ...prefixed, qdrant: { url: config.qdrant.url + '/proxy///' } },
        ['reindex', '--force'],
      )
      assert.equal(forced.code, 0, forced.stderr)
      assert.match(forced.stdout, /共处理 9 篇文献，其中 0 篇已索引而跳过/)
      waiting.release.resolve()
      await rejected
      assert.equal(
        calls.filter((call) => call.operation === 'query').length,
        before,
        'an old embedding or response must not start another vector request',
      )
    } finally {
      waiting.release.resolve()
      control.gate = undefined
      documents.lexical = lexical
      control.dense = undefined
    }
    assert.equal((await library.retrieve('needle'))[0].documentId, '8')
    assert.deepEqual(documents.list(), sources)
    assert.deepEqual(documents.passage(oldPassage.id), oldPassage)
  }

  // Start a fresh reader process with an equivalent URL: readiness and generation survive reopen.
  const reopened = await runNode(store.root, prefixed, [
    '--input-type=module',
    '--eval',
    `
    import { Store } from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
    import { LibraryStore } from ${JSON.stringify(new URL('./rag-store.ts', import.meta.url).href)};
    import { KnowledgeLibrary, ragConfig } from ${JSON.stringify(new URL('./rag.ts', import.meta.url).href)};
    const store = new Store(process.env.DATA_DIR);
    try {
      const library = new KnowledgeLibrary(new LibraryStore(store), ragConfig());
      console.log(JSON.stringify((await library.retrieve('needle')).map(p => p.documentId)));
    } finally { store.close(); }
  `,
  ])
  assert.equal(reopened.code, 0, reopened.stderr)
  assert.equal(JSON.parse(reopened.stdout)[0], '8')
})

test('canonical root and prefix aliases share readiness and invalidation without trusting legacy prefix markers', async (t) => {
  const { documents, store, config, calls } = await backend(t)
  const input = { id: 'canonical', title: '地址规范化测试', text: '第一条 共享标记测试。' }
  const digest = (url: string, collection: string) =>
    createHash('sha256')
      .update(JSON.stringify([new URL(url).href, collection]))
      .digest('hex')
  const independent = new KnowledgeLibrary(documents, {
    ...config,
    qdrant: { url: config.qdrant.url + '/different' },
  })
  await independent.import(input)
  for (const prefix of ['', '/proxy']) {
    const aliases = ['', '/', '///'].map(
      (suffix) =>
        new KnowledgeLibrary(documents, {
          ...config,
          qdrant: { url: config.qdrant.url + prefix + suffix },
        }),
    )
    const first = aliases[0]
    const versionId = documents.current(input.id)!
    await first.import(input)
    store.db
      .prepare('DELETE FROM rag_indexed_versions WHERE fingerprint=?')
      .run(first.indexFingerprint!)
    for (const suffix of ['', '/', '///']) {
      const legacy = digest(config.qdrant.url + prefix + suffix, first.vectors!.collection)
      store.db
        .prepare('INSERT OR IGNORE INTO rag_indexed_versions VALUES(?, ?)')
        .run(legacy, versionId)
      if (prefix) assert.notEqual(first.indexFingerprint, legacy)
      else if (suffix !== '///')
        assert.equal(
          first.indexFingerprint,
          legacy,
          'the default root URL must retain its old fingerprint',
        )
    }
    // Simulate upgrading a database that predates the generation table.
    store.db.exec('DROP TABLE rag_index_generations')
    new KnowledgeLibrary(documents, config)
    if (prefix) await assert.rejects(first.retrieve('测试'), { code: 'RAG_NOT_INDEXED' })
    const before = calls.length
    const imported = await first.import(input)
    assert.equal(imported.skipped, !prefix, 'only compatible root markers may be inherited')
    for (const alias of aliases) {
      assert.equal(alias.indexFingerprint, first.indexFingerprint)
      assert.equal(alias.vectors!.collection, first.vectors!.collection)
      assert.equal((await alias.retrieve('测试')).length, 1)
    }
    assert.ok(
      calls
        .slice(before)
        .filter((call) => call.operation !== 'embed')
        .every((call) => call.path.startsWith(prefix + '/collections/')),
    )
    aliases[2].invalidate()
    for (const alias of aliases)
      await assert.rejects(alias.retrieve('测试'), { code: 'RAG_NOT_INDEXED' })
    assert.equal(
      (await independent.retrieve('测试')).length,
      1,
      'a genuinely different endpoint keeps its own readiness',
    )
    await first.import(input)
    assert.equal((await aliases[1].retrieve('测试')).length, 1)
  }
})

test('invalidation rolls back the generation when marker deletion fails', async (t) => {
  const { library, store } = await backend(t)
  await library.import({ id: 'atomic', title: '原子失效测试', text: '第一条 原文。' })
  const generation = () =>
    store.db
      .prepare('SELECT generation FROM rag_index_generations WHERE fingerprint=?')
      .get(library.indexFingerprint!)!.generation
  const before = generation()
  store.db.exec(`CREATE TEMP TRIGGER fail_invalidation BEFORE DELETE ON rag_indexed_versions
    BEGIN SELECT RAISE(ABORT, 'test-only invalidation failure'); END;`)
  assert.throws(() => library.invalidate(), /test-only invalidation failure/)
  assert.equal(generation(), before)
  assert.equal((await library.retrieve('测试')).length, 1)
  store.db.exec('DROP TRIGGER fail_invalidation')
  library.invalidate()
  assert.equal(generation(), Number(before) + 1)
  await assert.rejects(library.retrieve('测试'), { code: 'RAG_NOT_INDEXED' })
})

test('the actual import and reindex CLI persists sources, resumes indexing, skips invalid lines on request and preserves an existing lock', async (t) => {
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
  const run = (args: string[]) => runCli(store.root, config, args)
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

  const embedCalls = () => calls.filter((call) => call.operation === 'embed').length
  const embedded = embedCalls()
  const again = await run(['import', path])
  assert.equal(again.code, 0, again.stderr)
  assert.match(again.stdout, /其中 2 篇已索引而跳过/)
  assert.equal(embedCalls(), embedded, 'unchanged indexed documents are not embedded again')

  // An interrupted rebuild leaves some documents without markers; reindex resumes with just those.
  store.db
    .prepare('DELETE FROM rag_indexed_versions WHERE fingerprint=? AND version_id=?')
    .run(library.indexFingerprint!, documents.current('a-test'))
  const waiting = gate('upsert')
  control.gate = waiting
  const rebuilding = run(['reindex'])
  await waiting.entered.promise
  assert.equal(markers(), 1, 'documents already indexed stay searchable during a rebuild')
  waiting.release.resolve()
  control.gate = undefined
  const rebuilt = await rebuilding
  assert.equal(rebuilt.code, 0, rebuilt.stderr)
  assert.match(rebuilt.stdout, /任务完成，共处理 2 篇文献，其中 1 篇已索引而跳过/)
  assert.equal(embedCalls(), embedded + 1)
  assert.equal(markers(), 2)
  assert.deepEqual(documents.list(), sources)
  assert.deepEqual(pointIds(), ids)
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' })

  const mixed = join(store.root, 'mixed.jsonl')
  const extra = { id: 'm-test', title: 'CLI 测试丙', text: '第一条 跳过无效行测试。' }
  await writeFile(mixed, ['{bad-json}', JSON.stringify(extra)].join('\n'))
  const strict = await run(['import', mixed])
  assert.equal(strict.code, 1)
  assert.match(strict.stderr, /第 1 行不是有效 UTF-8 文献 JSON/)
  assert.equal(documents.count(), 2)
  const lenient = await run(['import', mixed, '--skip-invalid'])
  assert.equal(lenient.code, 0, lenient.stderr)
  assert.match(lenient.stderr, /已跳过：第 1 行/)
  assert.match(lenient.stdout, /另有 1 行无效数据被跳过/)
  assert.equal(documents.current('m-test') !== null, true)
  assert.equal((await run(['reindex', '--skip-invalid'])).code, 1)
  assert.equal((await run(['import', path, '--force'])).code, 1)

  // Vectors lost outside this process (restored or edited Qdrant data) need a forced rebuild;
  // until it completes, answering fails as not indexed instead of using untrusted vectors.
  const beforeForce = embedCalls()
  const forcing = gate('upsert')
  control.gate = forcing
  const forcedRun = run(['reindex', '--force'])
  await forcing.entered.promise
  assert.equal(markers(), 0)
  await assert.rejects(library.retrieve('测试'), { code: 'RAG_NOT_INDEXED' })
  forcing.release.resolve()
  control.gate = undefined
  const forced = await forcedRun
  assert.equal(forced.code, 0, forced.stderr)
  assert.match(forced.stdout, /共处理 3 篇文献，其中 0 篇已索引而跳过/)
  assert.equal(embedCalls(), beforeForce + 3)

  await writeFile(lockPath, 'another-import-test-owner', { flag: 'wx' })
  const before = calls.length
  const blocked = await run(['import', path])
  assert.equal(blocked.code, 1)
  assert.match(blocked.stderr, /已有导入任务或遗留 rag-import.lock/)
  assert.doesNotMatch(blocked.stdout, /任务完成/)
  assert.equal(await readFile(lockPath, 'utf8'), 'another-import-test-owner')
  assert.equal(calls.length, before)
  assert.equal(markers(), 3)
  assert.equal(documents.count(), 3)
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
