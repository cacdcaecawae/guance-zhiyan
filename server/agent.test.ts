import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { TestModel, textChunks, toolChunks } from '../tests/support/model.ts'
import { Store } from './store.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'

test('existing SQLite sessions migrate without losing ownership and keep model selection on reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-migration-test-'))
  const old = new DatabaseSync(join(root, 'app.sqlite'))
  old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, subject TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, created INTEGER NOT NULL);
    INSERT INTO users VALUES('user', 'existing-user', 'Test');
    INSERT INTO sessions VALUES('session', 'user', '已有会话', 1);`)
  old.close()
  let store = new Store(root)
  try {
    assert.deepEqual(
      { ...store.session('user', 'session') },
      {
        id: 'session',
        title: '已有会话',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
      },
    )
    store.selectModel('user', 'session', { provider: 'qianwen', model: 'deepseek-v4.1-flash' })
    assert.throws(() => store.session('other', 'session'), /没有找到/)
    store.close()
    store = new Store(root)
    assert.equal(store.session('user', 'session').provider, 'qianwen')
    assert.equal(store.list('user')[0].title, '已有会话')
  } finally {
    store.close()
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-migration-test-'),
    )
    await rm(root, { recursive: true })
  }
})

test('native DSH: scoped tools, persistent history, cancellation, errors and budgets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-agent-test-'))
  const store = new Store(root)
  const model = new TestModel()
  let agents = await new Agents(store, { adapter: model, maxSteps: 2 }).init()
  try {
    const alice = store.user('test:alice', 'Alice')
    const bob = store.user('test:bob', 'Bob')
    const first = store.create(alice.id)
    await agents.start(alice.id, first.id, '生成报告')
    await agents.active.get(first.id)?.done
    const view = await agents.snapshot(alice.id, first.id)
    assert.equal(view.messages.at(-1)?.role, 'assistant')
    const answer = view.messages.at(-1)!
    assert.ok(answer.role === 'assistant' && answer.status === 'done')
    assert.ok(
      answer.parts.some(
        (part) => part.type === 'tool' && part.name === 'create_file' && part.status === 'done',
      ),
    )
    assert.equal(view.artifacts[0].format, 'docx')
    assert.match(await agents.files.read(alice.id, first.id, view.artifacts[0].id), /研究报告/)
    const exposed = model.requests[0].tools?.map((tool) => tool.name) ?? []
    assert.deepEqual(exposed.sort(), [
      'create_file',
      'list_files',
      'read_file',
      'web_fetch',
      'web_search',
    ])
    await assert.rejects(agents.snapshot(bob.id, first.id), /没有找到/)
    await assert.rejects(agents.stop(bob.id, first.id), /没有找到/)
    assert.throws(() => store.artifact(bob.id, view.artifacts[0].id), /没有找到/)

    const concurrentA = store.create(alice.id)
    const concurrentB = store.create(bob.id)
    await Promise.all([
      agents.start(alice.id, concurrentA.id, '生成报告'),
      agents.start(bob.id, concurrentB.id, '生成报告'),
    ])
    await Promise.all([
      agents.active.get(concurrentA.id)?.done,
      agents.active.get(concurrentB.id)?.done,
    ])
    const filesA = store.artifacts(alice.id, concurrentA.id)
    const filesB = store.artifacts(bob.id, concurrentB.id)
    assert.equal(filesA.length, 1)
    assert.equal(filesB.length, 1)
    assert.notEqual(filesA[0].id, filesB[0].id)
    assert.throws(() => store.artifact(alice.id, filesB[0].id), /没有找到/)

    await agents.close()
    agents = await new Agents(store, { adapter: model, maxSteps: 2 }).init()
    assert.deepEqual((await agents.snapshot(alice.id, first.id)).messages, view.messages)
    await agents.start(alice.id, first.id, '继续回答')
    await agents.active.get(first.id)?.done
    assert.ok(model.requests.at(-1)!.messages.filter((m) => m.role === 'user').length >= 2)

    const cancel = store.create(alice.id)
    await agents.start(alice.id, cancel.id, '持续生成')
    await new Promise<void>((resolveReady) => {
      const unsubscribe = agents.subscribe(alice.id, cancel.id, () => {
        if (agents.active.get(cancel.id)?.live?.chunks.some((c) => c.type === 'text-delta')) {
          unsubscribe()
          resolveReady()
        }
      })
      if (agents.active.get(cancel.id)?.live?.chunks.some((c) => c.type === 'text-delta')) {
        unsubscribe()
        resolveReady()
      }
    })
    await assert.rejects(agents.start(alice.id, cancel.id, 'another'), /仍在生成/)
    await agents.stop(alice.id, cancel.id)
    const stopped = (await agents.snapshot(alice.id, cancel.id)).messages.at(-1)!
    assert.ok(stopped.role === 'assistant' && stopped.status === 'stopped')
    assert.ok(stopped.parts.some((part) => part.type === 'text' && part.text.includes('部分内容')))

    const early = store.create(alice.id)
    const starting = agents.start(alice.id, early.id, '持续生成')
    await agents.stop(alice.id, early.id)
    await starting
    assert.equal((await agents.snapshot(alice.id, early.id)).running, false)

    const failed = store.create(alice.id)
    await agents.start(alice.id, failed.id, '模拟失败')
    await agents.active.get(failed.id)?.done
    const error = (await agents.snapshot(alice.id, failed.id)).messages.at(-1)!
    assert.ok(error.role === 'assistant' && error.status === 'error')

    const sheet = await agents.files.create(
      alice.id,
      first.id,
      '对比',
      'xlsx',
      JSON.stringify([
        ['项目', '数量'],
        ['甲', 3],
      ]),
    )
    assert.match(await agents.files.read(alice.id, first.id, sheet.id), /甲/)
    const csv = await agents.files.create(
      alice.id,
      first.id,
      '数据',
      'csv',
      JSON.stringify([['=1+1', 'a,b', 'a"b']]),
    )
    assert.match((await readFile(agents.files.path(csv.id))).toString(), /'=1\+1/)
    await assert.rejects(agents.files.create(alice.id, first.id, '../other', 'md', 'test'), /名称/)
    await assert.rejects(agents.files.read(alice.id, cancel.id, sheet.id), /当前会话/)

    model.respond = () => toolChunks('web_fetch', { url: 'http://127.0.0.1:1' })
    const loop = store.create(alice.id)
    await agents.start(alice.id, loop.id, 'repeat')
    await agents.active.get(loop.id)?.done
    const limited = (await agents.snapshot(alice.id, loop.id)).messages.at(-1)!
    assert.ok(limited.role === 'assistant' && limited.status === 'stopped')
    assert.ok(limited.parts.some((part) => part.type === 'tool' && part.status === 'error'))
  } finally {
    await agents.close()
    store.close()
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-agent-test-'),
    )
    await rm(root, { recursive: true })
  }
})

test('native Messages streaming and search protocol with cited sources and explicit failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-search-test-'))
  const savedKey = process.env.DEEPSEEK_API_KEY
  const savedBase = process.env.DEEPSEEK_SEARCH_BASE_URL
  const savedChatBase = process.env.DEEPSEEK_BASE_URL
  const savedDshHome = process.env.DSH_HOME
  const savedQianwen = [process.env.QIANWEN_API_KEY, process.env.QIANWEN_BASE_URL]
  const received: { provider: string; model: string; stream: boolean; users: number }[] = []
  const qianwen = { provider: 'qianwen', model: 'deepseek-v4.1-flash' }
  let valid = true
  let calls = 0
  const upstream = createServer(async (request, response) => {
    const isQianwen = request.url === '/qianwen/v1/messages'
    assert.equal(request.headers['x-api-key'], isQianwen ? 'qianwen-test-only' : 'test-only')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    received.push({
      provider: isQianwen ? 'qianwen' : 'deepseek-official',
      model: body.model,
      stream: !!body.stream,
      users: body.messages.filter((item: { role: string }) => item.role === 'user').length,
    })
    assert.ok(
      isQianwen
        ? ['deepseek-v4.1-flash', 'deepseek-v4-pro-0813'].includes(body.model)
        : ['deepseek-flash', 'deepseek-v4-pro'].includes(body.model),
    )
    if (body.stream) {
      assert.equal(request.url, isQianwen ? '/qianwen/v1/messages' : '/v1/messages')
      assert.equal(body.stream, true)
      assert.equal(body.max_tokens, 8192)
      assert.deepEqual(body.thinking, { type: 'enabled' })
      assert.deepEqual(body.output_config, { effort: 'high' })
      assert.equal(body.temperature, undefined)
      assert.ok(
        !JSON.stringify(body.messages).includes(isQianwen ? 'sig-official' : 'sig-qianwen'),
        "never replay the other provider's thinking signature",
      )
      response.setHeader('Content-Type', 'text/event-stream')
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '测试思考' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: isQianwen ? 'sig-qianwen' : 'sig-official' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: '原生适配器测试' },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ]
      const hanging = JSON.stringify(body.messages.at(-1)).includes('停止协议测试')
      response.write(
        (hanging ? events.slice(0, 7) : events)
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(''),
      )
      if (!hanging) response.end()
      return
    }
    assert.equal(request.url, isQianwen ? '/qianwen/v1/messages' : '/messages')
    if (isQianwen) {
      assert.equal(body.system, 'x-anthropic-billing-header: cc_entrypoint=cli;')
      assert.deepEqual(body.thinking, { type: 'disabled' })
    }
    assert.equal(body.tools[0].name, 'web_search')
    calls++
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        content: valid
          ? [
              {
                type: 'web_search_tool_result',
                tool_use_id: 'search-1',
                content: [
                  {
                    type: 'web_search_result',
                    url: 'https://example.org/source',
                    title: 'Test source',
                    encrypted_content: '',
                  },
                ],
              },
              {
                type: 'text',
                text: 'Test',
                citations: [
                  {
                    type: 'web_search_result_location',
                    url: 'https://example.org/source',
                    cited_text: 'Test excerpt',
                    title: 'Test source',
                    encrypted_index: '',
                  },
                ],
              },
            ]
          : [{ type: 'text', text: 'No actual search results' }],
      }),
    )
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  process.env.DEEPSEEK_API_KEY = 'test-only'
  process.env.DEEPSEEK_SEARCH_BASE_URL = `http://127.0.0.1:${address.port}`
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`
  process.env.DSH_HOME = join(root, 'dsh')
  process.env.QIANWEN_API_KEY = 'qianwen-test-only'
  process.env.QIANWEN_BASE_URL = `http://127.0.0.1:${address.port}/qianwen`
  const store = new Store(root)
  const model = new TestModel((request) =>
    request.messages.at(-1)?.role === 'tool'
      ? textChunks('完成')
      : toolChunks('web_search', { queries: ['test query'] }),
  )
  let agents = await new Agents(store, { adapter: model }).init()
  try {
    const user = store.user('search-test', 'Test')
    const session = store.create(user.id)
    await agents.start(user.id, session.id, 'search')
    await agents.active.get(session.id)?.done
    const answer = (await agents.snapshot(user.id, session.id)).messages.at(-1)!
    assert.ok(answer.role === 'assistant')
    const search = answer.parts.find((part) => part.type === 'tool')
    assert.ok(search?.type === 'tool' && search.status === 'done')
    assert.match(search.output, /https:\/\/example.org\/source/)
    assert.match(search.output, /Test excerpt/)
    assert.equal(calls, 1)
    const parallel = store.create(user.id)
    await Promise.all([
      agents.start(user.id, session.id, '换供应商搜索', qianwen),
      agents.start(user.id, parallel.id, '官方搜索'),
    ])
    await Promise.all([agents.active.get(session.id)?.done, agents.active.get(parallel.id)?.done])
    assert.equal(calls, 3)
    assert.equal(store.session(user.id, session.id).provider, 'qianwen')
    const qianwenAnswer = (await agents.snapshot(user.id, session.id)).messages.at(-1)!
    assert.ok(
      qianwenAnswer.role === 'assistant' &&
        qianwenAnswer.parts.some(
          (part) =>
            part.type === 'tool' && part.status === 'done' && part.output.includes('Test excerpt'),
        ),
    )
    valid = false
    const failure = store.create(user.id)
    await agents.start(user.id, failure.id, 'search')
    await agents.active.get(failure.id)?.done
    const failed = (await agents.snapshot(user.id, failure.id)).messages.at(-1)!
    assert.ok(
      failed.role === 'assistant' &&
        failed.parts.some((part) => part.type === 'tool' && part.status === 'error'),
    )
    await agents.start(user.id, failure.id, '千问搜索失败', qianwen)
    await agents.active.get(failure.id)?.done
    const qianwenFailed = (await agents.snapshot(user.id, failure.id)).messages.at(-1)!
    assert.ok(
      qianwenFailed.role === 'assistant' &&
        qianwenFailed.parts.some((part) => part.type === 'tool' && part.status === 'error'),
    )
    await agents.close()
    agents = await new Agents(store).init()
    const native = store.create(user.id)
    await agents.start(user.id, native.id, '协议测试')
    await agents.active.get(native.id)?.done
    const nativeAnswer = (await agents.snapshot(user.id, native.id)).messages.at(-1)!
    assert.ok(nativeAnswer.role === 'assistant' && nativeAnswer.status === 'done')
    assert.ok(
      nativeAnswer.parts.some((part) => part.type === 'text' && part.text === '原生适配器测试'),
    )
    await agents.start(user.id, native.id, '换千问继续', qianwen)
    await agents.active.get(native.id)?.done
    assert.deepEqual(received.at(-1), {
      provider: 'qianwen',
      model: qianwen.model,
      stream: true,
      users: 2,
    })
    await agents.close()
    agents = await new Agents(store).init()
    await agents.start(user.id, native.id, '重启继续')
    await agents.active.get(native.id)?.done
    assert.deepEqual(received.at(-1), {
      provider: 'qianwen',
      model: qianwen.model,
      stream: true,
      users: 3,
    })
    for (const selection of [
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { provider: 'qianwen', model: 'deepseek-v4-pro-0813' },
    ]) {
      await agents.start(user.id, native.id, '换 Pro', selection)
      await agents.active.get(native.id)?.done
      assert.equal(received.at(-1)?.model, selection.model)
    }
    for (const selection of [{ provider: 'deepseek-official', model: 'deepseek-flash' }, qianwen]) {
      const cancel = store.create(user.id)
      await agents.start(user.id, cancel.id, '停止协议测试', selection)
      await new Promise<void>((ready) => {
        const check = () => {
          if (
            agents.active.get(cancel.id)?.live?.chunks.some((chunk) => chunk.type === 'text-delta')
          ) {
            unsubscribe()
            ready()
          }
        }
        const unsubscribe = agents.subscribe(user.id, cancel.id, check)
        check()
      })
      // Move to a new job before collecting weak references in the live SSE transport.
      await new Promise<void>((done) => setImmediate(done))
      assert.ok(globalThis.gc, 'test:server must run with --expose-gc')
      globalThis.gc()
      await new Promise<void>((done) => setImmediate(done))
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          agents.stop(user.id, cancel.id),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('stream cancellation stalled after GC')),
              2000,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      const stopped = (await agents.snapshot(user.id, cancel.id)).messages.at(-1)!
      assert.ok(stopped.role === 'assistant' && stopped.status === 'stopped')
    }
    delete process.env.QIANWEN_API_KEY
    const count = received.length
    await assert.rejects(agents.start(user.id, native.id, '没有千问密钥'), /QIANWEN_API_KEY/)
    assert.equal(received.length, count, 'must not fall back to the official key')
  } finally {
    upstream.closeAllConnections()
    await agents.close()
    store.close()
    await new Promise<void>((done) => upstream.close(() => done()))
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = savedKey
    if (savedBase === undefined) delete process.env.DEEPSEEK_SEARCH_BASE_URL
    else process.env.DEEPSEEK_SEARCH_BASE_URL = savedBase
    if (savedChatBase === undefined) delete process.env.DEEPSEEK_BASE_URL
    else process.env.DEEPSEEK_BASE_URL = savedChatBase
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    for (const [index, key] of ['QIANWEN_API_KEY', 'QIANWEN_BASE_URL'].entries()) {
      if (savedQianwen[index] === undefined) delete process.env[key]
      else process.env[key] = savedQianwen[index]
    }
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-search-test-'),
    )
    await rm(root, { recursive: true })
  }
})

test('HTTP: authentication, ownership, request boundaries and file download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-http-test-'))
  const store = new Store(root)
  const agents = await new Agents(store, {
    adapter: new TestModel(() => textChunks('hello')),
  }).init()
  const server = createApp(store, agents, {
    origin: 'http://trusted.test',
    authenticate: async (req) =>
      typeof req.headers['x-test-user'] === 'string'
        ? { subject: req.headers['x-test-user'], name: 'Test' }
        : undefined,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    assert.equal((await fetch(base + '/api/me')).status, 401)
    assert.equal((await fetch(base + '/api/health')).headers.get('x-frame-options'), 'DENY')
    const headers = { 'x-test-user': 'alice', 'Content-Type': 'application/json' }
    const catalog = (await (await fetch(base + '/api/models', { headers })).json()) as {
      providers: { id: string }[]
    }
    assert.deepEqual(
      catalog.providers.map((item) => item.id),
      ['deepseek-official', 'qianwen'],
    )
    const created = await fetch(base + '/api/sessions', { method: 'POST', headers })
    const { id } = (await created.json()) as { id: string }
    assert.equal(created.status, 201)
    for (const selection of [
      null,
      { provider: 'qianwen', model: 'deepseek-flash' },
      { provider: 'https://evil.test', model: 'deepseek-flash' },
    ]) {
      assert.equal(
        (
          await fetch(`${base}/api/sessions/${id}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ question: 'hello', selection }),
          })
        ).status,
        400,
      )
    }
    assert.equal(
      (await fetch(`${base}/api/sessions/${id}`, { headers: { 'x-test-user': 'bob' } })).status,
      404,
    )
    assert.equal(
      (
        await fetch(`${base}/api/sessions/${id}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ question: ' ' }),
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await fetch(`${base}/api/sessions/${id}/messages`, {
          method: 'POST',
          headers: { ...headers, Origin: 'http://evil.test' },
          body: '{}',
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await fetch(`${base}/api/sessions/${id}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ question: 'hello' }),
        })
      ).status,
      202,
    )
    await agents.active.get(id)?.done
    const file = await agents.files.create(
      store.user('alice', 'Test').id,
      id,
      '报告',
      'md',
      '# 内容',
    )
    const download = await fetch(`${base}/api/files/${file.id}`, { headers })
    assert.equal(await download.text(), '# 内容')
    assert.match(download.headers.get('content-disposition')!, /attachment/)
    assert.equal(
      (await fetch(`${base}/api/files/${file.id}`, { headers: { 'x-test-user': 'bob' } })).status,
      404,
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    await agents.close()
    store.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-http-test-'))
    await rm(root, { recursive: true })
  }
})
