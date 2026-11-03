import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { TestModel } from '../tests/support/model.ts'
import { Accounts } from './accounts.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { Store } from './store.ts'

const ORIGIN = 'http://app.test'
const PASSWORD = 'correct horse battery'

async function host(t: TestContext, options: { secure?: boolean; trustProxy?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gczy-accounts-test-'))
  const store = new Store(root)
  const accounts = new Accounts(store, options)
  const agents = await new Agents(store, { adapter: new TestModel() }).init()
  const server = createApp(store, agents, { origin: ORIGIN, accounts })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.close()
    server.closeAllConnections()
    await agents.close()
    store.close()
    await rm(root, { recursive: true })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.cookie ? { Cookie: init.cookie } : {}),
        ...init.headers,
      },
    })
  const login = (username: string, password: string, headers: Record<string, string> = {}) =>
    call('/api/login', {
      method: 'POST',
      headers: { Origin: ORIGIN, ...headers },
      body: JSON.stringify({ username, password }),
    })
  /** 登录并返回只含会话令牌的 Cookie 请求头。 */
  const session = async (username: string) => {
    const response = await login(username, PASSWORD)
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  return { store, accounts, call, login, session }
}

test('passwords are salted scrypt hashes; wrong password and unknown user fail alike', async (t) => {
  const { store, accounts, login } = await host(t)
  assert.equal(await accounts.add('Alice', PASSWORD), 'alice')
  await accounts.add('bob', PASSWORD)
  const hashes = store.db.prepare('SELECT hash FROM accounts ORDER BY username').all()
  for (const { hash } of hashes) {
    assert.match(String(hash), /^scrypt:32768:8:1:/)
    assert.ok(!String(hash).includes(PASSWORD))
  }
  assert.notEqual(hashes[0].hash, hashes[1].hash, 'same password, different salt')
  await assert.rejects(accounts.add('alice', PASSWORD), /已存在/)
  await assert.rejects(accounts.add('bad name', PASSWORD), /用户名须为/)
  await assert.rejects(accounts.add('carol', 'short'), /密码须为/)
  assert.deepEqual(
    accounts.list().map((row) => row.username),
    ['alice', 'bob'],
  )

  const wrong = await login('alice', 'wrong password')
  const unknown = await login('nobody', PASSWORD)
  assert.equal(wrong.status, 401)
  assert.equal(unknown.status, 401)
  assert.deepEqual(await wrong.json(), await unknown.json())
  assert.equal(wrong.headers.get('set-cookie'), null)
  // 用户名不区分大小写
  assert.equal((await login('ALICE', PASSWORD)).status, 200)
})

test('login sets a hardened cookie; APIs need it; health is public; logout revokes it', async (t) => {
  const { accounts, call, login, session } = await host(t)
  await accounts.add('alice', PASSWORD)
  assert.equal((await call('/api/health')).status, 200)
  const anonymous = await call('/api/me')
  assert.equal(anonymous.status, 401)
  assert.equal((await anonymous.json()).login, true)
  assert.equal((await call('/api/sessions')).status, 401)
  assert.equal((await call('/api/sessions', { method: 'POST' })).status, 401)
  assert.equal((await call('/api/me', { cookie: 'gczy_session=forged' })).status, 401)

  const response = await login('alice', PASSWORD)
  assert.equal(response.status, 200)
  const user = await response.json()
  assert.equal(user.name, 'alice')
  assert.equal(user.login, true)
  const header = response.headers.get('set-cookie')!
  assert.match(header, /^gczy_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/)
  const cookie = header.split(';')[0]
  const me = await call('/api/me', { cookie })
  assert.equal(me.status, 200)
  assert.equal((await me.json()).name, 'alice')
  // 令牌只以摘要保存
  assert.ok(
    !JSON.stringify(accounts.db.prepare('SELECT * FROM logins').all()).includes(cookie.slice(13)),
  )

  // 外站不能代为登录或退出
  assert.equal((await login('alice', PASSWORD, { Origin: 'http://evil.test' })).status, 403)
  assert.equal(
    (await call('/api/logout', { method: 'POST', cookie, headers: { Origin: 'http://evil.test' } }))
      .status,
    403,
  )
  assert.equal((await call('/api/me', { cookie })).status, 200)

  const other = await session('alice')
  const out = await call('/api/logout', { method: 'POST', cookie, headers: { Origin: ORIGIN } })
  assert.equal(out.status, 200)
  assert.match(out.headers.get('set-cookie')!, /^gczy_session=; .*Max-Age=0/)
  assert.equal((await call('/api/me', { cookie })).status, 401)
  assert.equal((await call('/api/me', { cookie: other })).status, 200, 'other browsers stay')

  const secure = await host(t, { secure: true })
  await secure.accounts.add('alice', PASSWORD)
  assert.match(
    (await secure.login('alice', PASSWORD)).headers.get('set-cookie')!,
    /; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/,
  )
})

test('two accounts cannot see each other’s sessions', async (t) => {
  const { accounts, call, session } = await host(t)
  await accounts.add('alice', PASSWORD)
  await accounts.add('bob', PASSWORD)
  const alice = await session('alice')
  const bob = await session('bob')
  const created = await call('/api/sessions', {
    method: 'POST',
    cookie: alice,
    headers: { Origin: ORIGIN },
  })
  assert.equal(created.status, 201)
  const { id } = await created.json()
  assert.equal((await (await call('/api/sessions', { cookie: alice })).json()).length, 1)
  assert.deepEqual(await (await call('/api/sessions', { cookie: bob })).json(), [])
  assert.equal((await call(`/api/sessions/${id}`, { cookie: bob })).status, 404)
  assert.equal(
    (
      await call(`/api/sessions/${id}`, {
        method: 'DELETE',
        cookie: bob,
        headers: { Origin: ORIGIN },
      })
    ).status,
    404,
  )
  assert.equal((await call(`/api/sessions/${id}`, { cookie: alice })).status, 200)
})

test('failed logins back off per address and username; another machine cannot lock the owner out', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { accounts, login } = await host(t, { trustProxy: true })
  await accounts.add('alice', PASSWORD)
  const from = (address: string) => ({ 'X-Forwarded-For': address })
  for (let i = 0; i < 6; i++)
    assert.equal((await login('alice', 'wrong', from('10.0.0.1'))).status, 401)
  const blocked = await login('alice', PASSWORD, from('10.0.0.1'))
  assert.equal(blocked.status, 429, 'the guessing machine waits even with the right password')
  assert.equal(blocked.headers.get('retry-after'), '2')
  assert.equal((await login('alice', PASSWORD, from('10.0.0.2'))).status, 200, 'owner elsewhere')
  t.mock.timers.tick(2000)
  assert.equal((await login('alice', PASSWORD, from('10.0.0.1'))).status, 200)
  assert.equal(
    (await login('alice', 'wrong', from('10.0.0.1'))).status,
    401,
    'success clears the count',
  )
})

test('concurrent logins neither reject right passwords nor let guesses through', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const direct = await host(t)
  await direct.accounts.add('alice', PASSWORD)
  await direct.accounts.add('bob', PASSWORD)
  const burst = async (count: number, username: string, password: string) =>
    (await Promise.all(Array.from({ length: count }, () => direct.login(username, password)))).map(
      (response) => response.status,
    )
  assert.deepEqual(await burst(10, 'alice', PASSWORD), Array(10).fill(200))
  const guesses = await burst(20, 'bob', 'wrong')
  assert.equal(guesses.filter((status) => status === 401).length, 6)
  assert.equal(guesses.filter((status) => status === 429).length, 14)

  // 同一地址换着用户名猜：30 次以内不受限，之后整个地址一起等待；X-Forwarded-For 默认不采信
  const spray = (target: typeof direct, forwarded: string) =>
    Promise.all(
      Array.from({ length: 31 }, (_, i) =>
        target.login(`guess${i}`, 'wrong', { 'X-Forwarded-For': forwarded }),
      ),
    )
  t.mock.timers.tick(15 * 60_000)
  assert.ok((await spray(direct, '10.0.0.1')).every((response) => response.status === 401))
  assert.equal(
    (await direct.login('alice', PASSWORD, { 'X-Forwarded-For': '10.0.0.2' })).status,
    429,
  )

  const proxied = await host(t, { trustProxy: true })
  await proxied.accounts.add('alice', PASSWORD)
  await spray(proxied, '203.0.113.9, 10.0.0.1')
  assert.equal(
    (await proxied.login('alice', PASSWORD, { 'X-Forwarded-For': '10.0.0.1' })).status,
    429,
  )
  assert.equal(
    (await proxied.login('alice', PASSWORD, { 'X-Forwarded-For': '10.0.0.2' })).status,
    200,
  )
})

test('sessions slide for seven days of use; passwd and remove revoke them', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { accounts, call, session } = await host(t)
  await accounts.add('alice', PASSWORD)
  const cookie = await session('alice')
  const day = 24 * 3600_000
  t.mock.timers.tick(day / 2)
  assert.equal((await call('/api/me', { cookie })).headers.get('set-cookie'), null)
  t.mock.timers.tick(day)
  const refreshed = await call('/api/me', { cookie })
  assert.equal(refreshed.status, 200)
  assert.match(refreshed.headers.get('set-cookie')!, /Max-Age=604800/)
  t.mock.timers.tick(6.5 * day)
  assert.equal((await call('/api/me', { cookie })).status, 200, 'still within 7 days of use')
  t.mock.timers.tick(7 * day)
  assert.equal((await call('/api/me', { cookie })).status, 401, 'expired after 7 idle days')

  const before = await session('alice')
  await accounts.passwd('alice', 'another password')
  assert.equal((await call('/api/me', { cookie: before })).status, 401)
  const after = await (async () => {
    const response = await call('/api/login', {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: JSON.stringify({ username: 'alice', password: 'another password' }),
    })
    return response.headers.get('set-cookie')!.split(';')[0]
  })()
  assert.equal((await call('/api/me', { cookie: after })).status, 200)
  const subject = accounts.db.prepare('SELECT subject FROM accounts').get()!.subject
  accounts.remove('alice')
  assert.equal((await call('/api/me', { cookie: after })).status, 401)
  await accounts.add('alice', PASSWORD)
  assert.notEqual(
    accounts.db.prepare('SELECT subject FROM accounts').get()!.subject,
    subject,
    'a re-created name does not inherit the old records',
  )
})
