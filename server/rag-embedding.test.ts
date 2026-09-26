import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
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
  const input = Array.from({ length: 17 }, (_, index) => String(index))
  config.model = 'mutated'
  assert.deepEqual(
    await embeddings.embed(input),
    input.map((text) => [Number(text), 1]),
  )
  assert.deepEqual(
    calls.map((call) => call.length),
    [16, 1],
  )
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
  const url = await endpoint(t, (_request, response) => {
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
    await assert.rejects(embeddings.embed(['text']), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, /test-only-key|private-source-content/)
      assert.equal(error.cause, undefined)
      return true
    })
  }
  status = 200
  body = ' '.repeat(16 * 1024 * 1024 + 1)
  await assert.rejects(embeddings.embed(['text']), /无效响应/)
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
  const url = await endpoint(t, (_request, response) => {
    response.writeHead(307, { Location: destination })
    response.end()
  })
  const embeddings = new Embeddings({ url, model: 'test', dimensions: 2, apiKey: 'test-only-key' })
  await assert.rejects(embeddings.embed(['text']), /向量服务请求失败/)
  assert.equal(destinationCalled, false)
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
