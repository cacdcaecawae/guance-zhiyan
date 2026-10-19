import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createSecureServer } from 'node:http2'
import { connect, type AddressInfo } from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { configureNetwork } from './network.ts'

test('DSH proxy resolves public hostnames while private URLs and loopback retain their policy', async () => {
  const proxied: string[] = []
  const proxy = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain')
    if (request.url?.startsWith('http://')) {
      proxied.push(request.url)
      response.end('public')
    } else response.end('local')
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address !== 'string')
  const localURL = `http://127.0.0.1:${address.port}`
  const dispose = await configureNetwork({ HTTP_PROXY: localURL })
  try {
    const provider = new HttpFetchProvider(
      {
        maxResponseBytes: 5000000,
        maxBodyChars: 100000,
        timeoutMs: 30000,
        maxRedirects: 5,
        userAgent: 'test',
      },
      async () => {
        throw new Error('Public hostname must be resolved by proxy, not fake-IP DNS')
      },
    )
    const result = await provider.fetch({ url: 'http://public.invalid/' })
    assert.equal(result.body.content, 'public')
    assert.deepEqual(proxied, ['http://public.invalid/'])
    const response = await fetch('http://another-public.invalid/')
    assert.equal(await response.text(), 'public')
    assert.equal(proxied.length, 2)
    assert.equal(proxyRouteFor(new URL(localURL)).proxied, false)
    assert.equal(await (await fetch(localURL)).text(), 'local')
    const native = new HttpFetchProvider({
      maxResponseBytes: 5000000,
      maxBodyChars: 100000,
      timeoutMs: 30000,
      maxRedirects: 5,
      userAgent: 'test',
    })
    for (const url of ['http://127.0.0.1/', 'http://192.168.0.1/', 'http://198.18.0.1/'])
      await assert.rejects(native.fetch({ url }), { code: 'WEB_BLOCKED_URL' })
    assert.equal(proxied.length, 2)
  } finally {
    await dispose()
    proxy.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    )
  }
  assert.equal(proxyRouteFor(new URL('http://public.invalid/')).proxied, false)
})

const tls = new URL('../tests/support/tls/', import.meta.url)
const stream = 'event: message_start\ndata: {}\n\n'

// The proxy dispatchers of dsh-http-proxy (undici 8) must not negotiate HTTP/2: Node's built-in
// fetch (undici 7) then gets no response headers and leaves compressed model streams undecoded.
test('built-in fetch keeps headers and decoding through the proxy policy dispatchers', async (t) => {
  // An HTTPS server preferring HTTP/2, as api.deepseek.com does, replying with a gzip event stream.
  const server = createSecureServer(
    {
      key: readFileSync(new URL('test-only.key', tls)),
      cert: readFileSync(new URL('test-only.crt', tls)),
      allowHTTP1: true,
    },
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' })
      response.end(gzipSync(stream))
    },
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  // An HTTP CONNECT proxy tunnelling every target to that server.
  const tunnelled: string[] = []
  const proxy = createServer().on('connect', (request, socket, head) => {
    tunnelled.push(request.url!)
    const upstream = connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket).pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(() => {
    server.close()
    proxy.closeAllConnections()
    proxy.close()
  })

  // A separate process installs the dispatchers as the server does, trusting the test certificate
  // only there (NODE_EXTRA_CA_CERTS), and fetches through the proxy, around it (loopback), and
  // directly again after the proxy is cleared.
  const script = `
    import { configureNetwork } from ${JSON.stringify(new URL('./network.ts', import.meta.url).href)}
    const read = async (url) => {
      const response = await fetch(url)
      return [response.headers.get('content-type'), await response.text()]
    }
    const [proxied, direct] = process.argv.slice(1)
    const viaProxy = await configureNetwork(process.env, () => {})
    const results = [await read(proxied), await read(direct)]
    const cleared = await configureNetwork({}, () => {})
    results.push(await read(direct))
    console.log(JSON.stringify(results))
    await cleared()
    await viaProxy()
  `
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(https?|all|no)_proxy$/i.test(key) && key !== 'NODE_TEST_CONTEXT',
    ),
  )
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '--eval',
      script,
      `https://proxied.test:${port}/`,
      `https://localhost:${port}/`,
    ],
    {
      timeout: 20000,
      env: {
        ...env,
        HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('test-only.crt', tls)),
      },
    },
  )
  const ok = ['text/event-stream', stream]
  assert.deepEqual(JSON.parse(stdout), [ok, ok, ok])
  assert.deepEqual(tunnelled, [`proxied.test:${port}`])
})
