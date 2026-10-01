import assert from 'node:assert/strict'
import { createServer, type RequestListener, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { test, type TestContext } from 'node:test'
import { Embeddings } from './rag-embedding.ts'

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
  return `http://127.0.0.1:${address.port}/embeddings`
}

test('embeddings send authenticated batches, restore response order and fingerprint the vector space', async (t) => {
  const calls: string[][] = []
  const url = await endpoint(t, async (request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/embeddings')
    assert.equal(request.headers.authorization, 'Bearer test-only-key')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(body.model, 'test-embedding')
    assert.equal(body.dimensions, 2)
    calls.push(body.input)
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        data: body.input
          .map((text: string, index: number) => ({ index, embedding: [Number(text), 1] }))
          .reverse(),
      }),
    )
  })
  const config = { url, model: 'test-embedding', dimensions: 2, apiKey: 'test-only-key' }
  const embeddings = new Embeddings(config)
  const input = Array.from({ length: 11 }, (_, index) => String(index))
  config.model = 'mutated'
  assert.deepEqual(
    await embeddings.embed(input),
    input.map((text) => [Number(text), 1]),
  )
  assert.deepEqual(
    calls.map((call) => call.length),
    [10, 1],
  )
  calls.length = 0
  await new Embeddings({ ...config, model: 'test-embedding', batchSize: 4 }).embed(input)
  assert.deepEqual(
    calls.map((call) => call.length),
    [4, 4, 3],
  )
  for (const batchSize of [0, 1.5, NaN])
    assert.throws(() => new Embeddings({ ...config, batchSize }), /批量条数/)
  assert.deepEqual(await embeddings.embed([]), [])
  const original = { ...config, model: 'test-embedding' }
  assert.equal(
    embeddings.fingerprint,
    new Embeddings({ ...original, apiKey: 'rotated' }).fingerprint,
  )
  for (const changed of [{ model: 'other' }, { dimensions: 3 }, { url: `${url}/other` }])
    assert.notEqual(embeddings.fingerprint, new Embeddings({ ...original, ...changed }).fingerprint)
})

test('embeddings reject malformed responses and never expose response bodies or credentials', async (t) => {
  let status = 200
  let body = ''
  let calls = 0
  const url = await endpoint(t, (_request, response) => {
    calls++
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(body)
  })
  const embeddings = new Embeddings({ url, model: 'test', dimensions: 2, apiKey: 'test-only-key' })
  const invalid = [
    null,
    { data: [] },
    { data: [{ index: 1, embedding: [1, 2] }] },
    { data: [{ index: 0, embedding: [1] }] },
    { data: [{ index: 0, embedding: [0, 0] }] },
    { data: [{ index: 0, embedding: ['1', 2] }] },
    { data: [{ index: 0, embedding: [null, 2] }] },
  ]
  for (const payload of invalid) {
    body = JSON.stringify(payload)
    await assert.rejects(embeddings.embed(['text']), /向量服务返回/)
  }
  body = '{"data":[{"index":0,"embedding":[1e999,2]}]}'
  await assert.rejects(embeddings.embed(['text']), /数值无效/)
  body = JSON.stringify({
    data: [
      { index: 0, embedding: [1, 2] },
      { index: 0, embedding: [3, 4] },
    ],
  })
  await assert.rejects(embeddings.embed(['first', 'second']), /索引/)
  for (const failureStatus of [200, 401, 429, 500]) {
    status = failureStatus
    body = 'test-only-key private-source-content'
    await assert.rejects(embeddings.embed(['text'], undefined, 0), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, /test-only-key|private-source-content/)
      assert.equal(error.cause, undefined)
      return true
    })
  }
  status = 200
  body = '{"data":['
  let before = calls
  await assert.rejects(embeddings.embed(['text']), /无效响应/)
  assert.equal(calls, before + 1, 'complete but malformed JSON is not a transport failure')
  body = ' '.repeat(16 * 1024 * 1024 + 1)
  before = calls
  await assert.rejects(embeddings.embed(['text']), /无效响应/)
  assert.equal(calls, before + 1, 'oversized bodies are not retried')
})

test('embeddings retry a dropped response body without repeating completed batches', async (t) => {
  const calls: string[][] = []
  const received = Promise.withResolvers<void>()
  let broken: ServerResponse | undefined
  const url = await endpoint(t, async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const { input } = JSON.parse(Buffer.concat(chunks).toString())
    calls.push(input)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    if (calls.length === 2) {
      broken = response
      response.write('{"data":[')
    } else response.end(JSON.stringify({ data: [{ index: 0, embedding: [Number(input[0]), 1] }] }))
  })
  const nativeFetch = globalThis.fetch
  // Observe actual response headers before severing the real HTTP connection; do not fake its body.
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await nativeFetch(...args)
    if (calls.length === 2) received.resolve()
    return response
  })
  const embeddings = new Embeddings({ url, model: 'test', dimensions: 2, batchSize: 1 })
  const pending = embeddings.embed(['1', '2', '3'])
  const outcome = pending.then(
    (vectors) => ({ vectors }),
    (error: unknown) => ({ error }),
  )
  await received.promise
  broken!.destroy()
  assert.deepEqual(await outcome, {
    vectors: [
      [1, 1],
      [2, 1],
      [3, 1],
    ],
  })
  assert.deepEqual(calls, [['1'], ['2'], ['2'], ['3']])
})

test('embeddings cap repeated response-body disconnects and sanitize the failure', async (t) => {
  let calls = 0
  let broken: ServerResponse | undefined
  const url = await endpoint(t, (_request, response) => {
    calls++
    broken = response
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.write('{"private-source-content":')
  })
  const nativeFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await nativeFetch(...args)
    broken!.destroy()
    return response
  })
  const embeddings = new Embeddings({ url, model: 'test', dimensions: 2, apiKey: 'test-only-key' })
  await assert.rejects(embeddings.embed(['text'], undefined, 1), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /向量服务请求失败/)
    assert.doesNotMatch(error.message, /private-source-content|test-only-key|127\.0\.0\.1/)
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(calls, 2, 'one initial attempt plus one retry, never an unbounded loop')
})

test('embeddings propagate cancellation before a request and while receiving its body', async (t) => {
  let started!: () => void
  const received = new Promise<void>((resolve) => {
    started = resolve
  })
  const url = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.write('{"data":[')
    started()
  })
  const embeddings = new Embeddings({ url, model: 'test', dimensions: 2 })
  const cancelled = AbortSignal.abort(new Error('private-cancellation-reason'))
  await assert.rejects(embeddings.embed(['text'], cancelled), { name: 'AbortError' })
  const controller = new AbortController()
  const pending = embeddings.embed(['text'], controller.signal)
  await received
  controller.abort(new Error('private-cancellation-reason'))
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'AbortError')
    assert.doesNotMatch(error.message, /private-cancellation-reason/)
    return true
  })
})

test('embeddings reject redirects and invalid configuration without leaking secrets', async (t) => {
  let destinationCalled = false
  const destination = await endpoint(t, (_request, response) => {
    destinationCalled = true
    response.end('{}')
  })
  let redirects = 0
  const url = await endpoint(t, (_request, response) => {
    redirects++
    response.writeHead(307, { Location: destination })
    response.end()
  })
  const embeddings = new Embeddings({ url, model: 'test', dimensions: 2, apiKey: 'test-only-key' })
  await assert.rejects(embeddings.embed(['text']), /向量服务请求失败/)
  assert.equal(destinationCalled, false)
  assert.equal(redirects, 1, 'a redirect is a configuration error and is not retried')
  await assert.rejects(embeddings.embed([' ']), /输入不能为空/)
  for (const badURL of [
    'invalid-test-only-key',
    'ftp://localhost/model',
    'http://user:test-only-key@localhost/',
  ])
    assert.throws(
      () => new Embeddings({ url: badURL, model: 'test', dimensions: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.doesNotMatch(error.message, /test-only-key/)
        return true
      },
    )
  for (const dimensions of [0, -1, 0.5, Infinity])
    assert.throws(() => new Embeddings({ url, model: 'test', dimensions }), /配置无效/)
  assert.throws(() => new Embeddings({ url, model: ' ', dimensions: 2 }), /配置无效/)
})

test('embeddings retry timeouts, rate limits and server errors with backoff, but not client errors', async (t) => {
  const statuses: number[] = []
  let calls = 0
  const url = await endpoint(t, (_request, response) => {
    const status = statuses[calls++] ?? 200
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(status === 200 ? JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }) : '')
  })
  const embeddings = new Embeddings({ url, model: 'test', dimensions: 2 })
  statuses.push(408, 429)
  assert.deepEqual(await embeddings.embed(['text']), [[1, 0]])
  assert.equal(calls, 3)

  calls = 0
  statuses.splice(0, statuses.length, 400)
  await assert.rejects(embeddings.embed(['text']), /HTTP 400/)
  assert.equal(calls, 1, 'a client error is not retried')

  calls = 0
  statuses.splice(0, statuses.length, 503, 503)
  await assert.rejects(embeddings.embed(['text'], undefined, 1), /HTTP 503/)
  assert.equal(calls, 2, 'retries stop at the given count')

  calls = 0
  statuses.splice(0, statuses.length, 503)
  const controller = new AbortController()
  const pending = embeddings.embed(['text'], controller.signal)
  while (calls < 1) await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 1, 'cancellation stops the backoff wait')
})
