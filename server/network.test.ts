import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
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
