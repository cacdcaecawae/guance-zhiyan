import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authenticate as closed, localAuthenticate } from './auth.ts'

test('local identity is explicit, loopback and same-origin only; production stays closed', async () => {
  const origin = 'http://127.0.0.1:3001'
  const authenticate = localAuthenticate(origin)
  const local = (request: IncomingMessage) => authenticate(request, {} as ServerResponse)
  const request = (headers: IncomingMessage['headers'], peer = '127.0.0.1') =>
    ({ headers, socket: { remoteAddress: peer } }) as IncomingMessage
  const headers = { host: '127.0.0.1:3001', origin, 'sec-fetch-site': 'same-origin' }
  assert.equal((await local(request(headers)))?.subject, 'local:owner')
  assert.equal((await local(request({ host: headers.host })))?.subject, 'local:owner')
  assert.equal(await closed(request(headers), {} as ServerResponse), undefined)
  assert.equal(await local(request(headers, '192.168.1.2')), undefined)
  for (const denied of [
    { ...headers, host: 'evil.test:3001' },
    { ...headers, host: '127.0.0.1:4000' },
    { ...headers, origin: 'http://127.0.0.1:4000' },
    { ...headers, 'sec-fetch-site': 'cross-site' },
    { ...headers, 'sec-fetch-site': 'same-site' },
    { ...headers, forwarded: 'for=192.168.1.2' },
    { ...headers, 'x-forwarded-host': 'public.test' },
  ])
    assert.equal(await local(request(denied)), undefined)
  assert.throws(() => localAuthenticate('http://0.0.0.0:3001'))
})
