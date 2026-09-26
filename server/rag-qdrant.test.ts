import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { Qdrant } from './rag-qdrant.ts'

async function endpoint(t: TestContext, handler: RequestListener) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

const collection = (size = 2, distance = 'Cosine') => ({
  config: { params: { vectors: { size, distance } } },
})
const completed = { status: 'completed', operation_id: 1 }
const reply = (result: unknown) => JSON.stringify({ status: 'ok', result })

test('Qdrant creates missing collections, verifies existing configuration and handles concurrent creation', async (t) => {
  let exists = false
  let conflict = false
  let config: unknown = collection()
  let puts = 0
  const url = await endpoint(t, async (request, response) => {
    assert.equal(request.headers['api-key'], 'test-only-key')
    assert.equal(request.url?.split('?')[0], '/proxy/collections/rag_test')
    if (request.method === 'GET') {
      if (!exists) {
        response.writeHead(404)
        response.end()
        return
      }
      response.end(reply(config))
    } else {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        vectors: { size: 2, distance: 'Cosine' },
      })
      assert.equal(request.url, '/proxy/collections/rag_test?timeout=25')
      exists = true
      puts++
      response.writeHead(conflict ? 409 : 200)
      response.end(reply(true))
    }
  })
  const client = new Qdrant({
    url: `${url}/proxy/`,
    collection: 'rag_test',
    dimensions: 2,
    apiKey: 'test-only-key',
  })
  let invalidations = 0
  const invalidate = () => {
    assert.equal(exists, false, 'persist index invalidation before creating a collection')
    invalidations++
  }
  assert.equal(await client.ensureCollection(undefined, invalidate), true)
  assert.equal(await client.ensureCollection(undefined, invalidate), false)
  assert.equal(puts, 1)
  assert.equal(invalidations, 1)
  exists = false
  conflict = true
  assert.equal(await client.ensureCollection(undefined, invalidate), true)
  assert.equal(puts, 2)
  assert.equal(invalidations, 2)
  for (const incompatible of [
    collection(3),
    collection(2, 'Dot'),
    { config: { params: { vectors: { named: { size: 2, distance: 'Cosine' } } } } },
  ]) {
    config = incompatible
    await assert.rejects(client.ensureCollection(), /不兼容/)
  }
  exists = false
  await assert.rejects(
    client.ensureCollection(undefined, () => {
      throw new Error('Index invalidation failed')
    }),
    /Index invalidation failed/,
  )
  assert.equal(puts, 2, 'failed invalidation must prevent collection creation')
})

test('Qdrant batches point writes and deletion, preserves version payloads, and returns finite scored IDs', async (t) => {
  const passages = Array.from({ length: 130 }, () => ({
    id: randomUUID(),
    versionId: randomUUID(),
    documentId: 'source-doc',
  }))
  const vectors = passages.map(() => [1, 2])
  const writes: unknown[][] = []
  const deletions: string[][] = []
  const offsets: number[] = []
  const url = await endpoint(t, async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(request.headers['api-key'], undefined)
    if (request.method === 'PUT') {
      assert.equal(request.url, '/collections/rag/points?wait=true&timeout=25')
      writes.push(body.points)
      response.end(reply(completed))
    } else if (request.url?.includes('/delete')) {
      assert.equal(request.url, '/collections/rag/points/delete?wait=true&timeout=25')
      deletions.push(body.points)
      response.end(reply(completed))
    } else {
      assert.equal(request.url, '/collections/rag/points/query?timeout=25')
      assert.deepEqual(body, {
        query: [1, 2],
        limit: 2,
        offset: offsets.length * 80,
        with_payload: false,
        with_vector: false,
      })
      offsets.push(body.offset)
      response.end(
        reply({ points: [{ id: passages[0].id, score: 0.9, payload: { unexpected: true } }] }),
      )
    }
  })
  const client = new Qdrant({ url, collection: 'rag', dimensions: 2 })
  await client.upsert(passages, vectors)
  assert.deepEqual(
    writes.map((batch) => batch.length),
    [64, 64, 2],
  )
  assert.deepEqual(
    writes.flat(),
    passages.map((passage) => ({
      id: passage.id,
      vector: [1, 2],
      payload: { documentId: passage.documentId, versionId: passage.versionId },
    })),
  )
  assert.deepEqual(await client.search([1, 2], 2), [{ id: passages[0].id, score: 0.9 }])
  assert.deepEqual(await client.search([1, 2], 2, undefined, 80), [
    { id: passages[0].id, score: 0.9 },
  ])
  assert.deepEqual(offsets, [0, 80])
  await client.delete(passages.map((passage) => passage.id))
  assert.deepEqual(
    deletions.map((batch) => batch.length),
    [64, 64, 2],
  )
  assert.deepEqual(
    deletions.flat(),
    passages.map((passage) => passage.id),
  )
  await client.upsert([], [])
  await client.delete([])
  assert.equal(writes.length, 3)
  assert.equal(deletions.length, 3)
})

test('Qdrant refuses invalid inputs and incomplete or malformed successful responses', async (t) => {
  let body = reply(completed)
  let calls = 0
  const url = await endpoint(t, (_request, response) => {
    calls++
    response.end(body)
  })
  const client = new Qdrant({ url, collection: 'rag', dimensions: 2 })
  const passage = { id: randomUUID(), versionId: randomUUID(), documentId: 'doc' }
  for (const vector of [[0, 0], [1], [Infinity, 1], [1e100, 1], [1e-100, 0]])
    await assert.rejects(client.upsert([passage], [vector]), /数值无效/)
  await assert.rejects(client.upsert([passage], []), /条数不符/)
  await assert.rejects(
    client.upsert(
      [passage, passage],
      [
        [1, 2],
        [1, 2],
      ],
    ),
    /标识无效或重复/,
  )
  await assert.rejects(client.delete(['invalid']), /标识无效/)
  for (const limit of [0, -1, 0.5, 1001]) await assert.rejects(client.search([1, 2], limit), /条数/)
  for (const offset of [-1, 0.5, 10001])
    await assert.rejects(client.search([1, 2], 2, undefined, offset), /偏移/)
  assert.equal(calls, 0)
  body = reply({ status: 'acknowledged', operation_id: 1 })
  await assert.rejects(client.upsert([passage], [[1, 2]]), /尚未完成/)
  await assert.rejects(client.delete([passage.id]), /尚未完成/)
  for (const result of [
    null,
    { points: null },
    { points: [{ id: 42, score: 0.1 }] },
    { points: [{ id: passage.id, score: '0.1' }] },
    {
      points: [
        { id: passage.id, score: 0.1 },
        { id: passage.id, score: 0.2 },
      ],
    },
  ]) {
    body = reply(result)
    await assert.rejects(client.search([1, 2], 2), /响应无效|得分无效/)
  }
  body = `{"status":"ok","result":{"points":[{"id":"${passage.id}","score":1e999}]}}`
  await assert.rejects(client.search([1, 2], 2), /得分无效/)
  body = reply({ points: [0, 1, 2].map(() => ({ id: randomUUID(), score: 0.1 })) })
  await assert.rejects(client.search([1, 2], 2), /响应无效/)
})

test('Qdrant errors hide provider bodies and credentials and never follow redirects', async (t) => {
  let status = 500
  let body = 'test-only-key private-source-content'
  let destinationCalls = 0
  const target = await endpoint(t, (_request, response) => {
    destinationCalls++
    response.end('{}')
  })
  const url = await endpoint(t, (_request, response) => {
    response.writeHead(status, { Location: target })
    response.end(body)
  })
  const client = new Qdrant({ url, collection: 'rag', dimensions: 2, apiKey: 'test-only-key' })
  for (const code of [200, 401, 500, 307]) {
    status = code
    await assert.rejects(client.search([1, 2], 2), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, /test-only-key|private-source-content/)
      assert.equal(error.cause, undefined)
      return true
    })
  }
  assert.equal(destinationCalls, 0)
  status = 200
  body = JSON.stringify({ status: { error: 'test-only-key' }, result: { points: [] } })
  await assert.rejects(client.search([1, 2], 2), /无效响应/)
  body = ' '.repeat(2 * 1024 * 1024 + 1)
  await assert.rejects(client.search([1, 2], 2), /无效响应/)
  for (const invalid of [
    'bad-test-only-key',
    'http://user:test-only-key@localhost',
    'ftp://localhost',
    `${url}?key=test-only-key`,
  ])
    assert.throws(
      () => new Qdrant({ url: invalid, collection: 'rag', dimensions: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.doesNotMatch(error.message, /test-only-key/)
        return true
      },
    )
})

test('Qdrant cancellation closes an unfinished response and prevents subsequent batches', async (t) => {
  let started!: () => void
  const received = new Promise<void>((resolve) => {
    started = resolve
  })
  let closed!: () => void
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve
  })
  let calls = 0
  const url = await endpoint(t, (_request, response) => {
    calls++
    response.once('close', closed)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.write('{"status":"ok",')
    started()
  })
  const client = new Qdrant({ url, collection: 'rag', dimensions: 2 })
  const cancelled = AbortSignal.abort(new Error('private-reason'))
  await assert.rejects(client.search([1, 2], 2, cancelled), { name: 'AbortError' })
  assert.equal(calls, 0)
  const controller = new AbortController()
  const pending = client.delete(
    Array.from({ length: 65 }, () => randomUUID()),
    controller.signal,
  )
  await received
  controller.abort(new Error('private-reason'))
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'AbortError')
    assert.doesNotMatch(error.message, /private-reason/)
    return true
  })
  await disconnected
  assert.equal(calls, 1)
})
