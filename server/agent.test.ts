import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_MAX_TOKENS } from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { traceFromEvents } from './trace.ts'
import { messagesFromEvents, toolInput, toolError } from './view.ts'
import { TestModel, textChunks, toolChunks } from '../tests/support/model.ts'
import { Store } from './store.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'

test('existing SQLite sessions migrate without losing ownership and keep model selection on reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-migration-test-'))
  const old = new DatabaseSync(join(root, 'app.sqlite'))
  old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, subject TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, format TEXT NOT NULL, size INTEGER NOT NULL);
    INSERT INTO artifacts VALUES('unknown', 'session', 'unknown.docx', 'docx', 100);
    INSERT INTO users VALUES('user', 'existing-user', 'Test');
    INSERT INTO sessions VALUES('session', 'user', '已有会话', 1);`)
  old.close()
  if (process.platform !== 'win32') {
    await chmod(root, 0o777)
    await chmod(join(root, 'app.sqlite'), 0o666)
  }
  let store = new Store(root)
  try {
    if (process.platform !== 'win32') {
      assert.equal((await stat(root)).mode & 0o777, 0o700)
      for (const name of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'])
        assert.equal((await stat(join(root, name))).mode & 0o777, 0o600)
    }
    assert.equal(store.generatedArtifact('user', 'unknown'), false)
    assert.deepEqual({ ...store.user('existing-user', 'Changed') }, { id: 'user', name: 'Changed' })
    store.db.exec('UPDATE artifacts SET generated=1; PRAGMA user_version=0;')
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
    assert.equal(
      store.generatedArtifact('user', 'unknown'),
      false,
      'revoke trust assigned by early builds',
    )
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

test('native DSH: scoped tools, persistent history, cancellation and long-running tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-agent-test-'))
  const store = new Store(root)
  const model = new TestModel()
  let agents = await new Agents(store, { adapter: model }).init()
  try {
    const alice = store.user('test:alice', 'Alice')
    const bob = store.user('test:bob', 'Bob')
    const first = store.create(alice.id)
    await agents.start(alice.id, first.id, '生成报告')
    await agents.active.get(first.id)?.done
    const view = await agents.snapshot(alice.id, first.id)
    assert.deepEqual(
      view.trace.map((entry) => entry.kind),
      ['system', 'user', 'assistant', 'tool', 'assistant'],
    )
    assert.ok(view.trace.every((entry) => entry.turn === 1))
    assert.ok(
      view.trace
        .filter((entry) => entry.kind === 'tool' || entry.kind === 'assistant')
        .every((entry) => entry.end !== undefined && entry.end >= entry.time),
    )
    assert.equal(view.trace.find((entry) => entry.kind === 'tool')?.status, 'done')
    assert.equal(view.messages.at(-1)?.role, 'assistant')
    const answer = view.messages.at(-1)!
    assert.ok(answer.role === 'assistant' && answer.status === 'done')
    assert.ok(
      answer.parts.some(
        (part) => part.type === 'tool' && part.name === 'create_file' && part.status === 'done',
      ),
    )
    assert.equal(view.artifacts[0].format, 'docx')
    const history = await agents.events(first.id)
    const interrupted = history.filter(
      (event) => event.type !== 'turn/end' && event.type !== 'tool/result',
    )
    const start = history.find((event) => event.type === 'turn/start')!
    const resumed = [
      ...interrupted,
      { ...start, seq: history.length + 1, data: { ...start.data, turn: 2 } },
    ] as SessionEvent[]
    const projected = messagesFromEvents(resumed, true).filter(
      (message) => message.role === 'assistant',
    )
    assert.equal(projected[0].status, 'stopped')
    assert.equal(projected[1].status, 'loading')
    assert.equal(
      traceFromEvents(resumed, true).find((row) => row.kind === 'tool')?.status,
      'stopped',
    )
    const largeCall = history.map((event) =>
      event.type === 'tool/call'
        ? {
            ...event,
            data: {
              ...event.data,
              arguments: JSON.stringify({ content: 'x'.repeat(200000), name: '报告.docx' }),
            },
          }
        : event,
    )
    const input = traceFromEvents(largeCall, false).find((row) => row.kind === 'tool')!.input!
    assert.ok(input.length < 2000)
    assert.equal(JSON.parse(input).name, '报告.docx')
    assert.equal(toolInput(input), input)
    assert.match(toolError('FILE_QUOTA'), /空间已达上限/)
    assert.match(toolError('FILE_WORKSPACE_ONLY'), /当前会话工作区/)
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
    agents = await new Agents(store, { adapter: model }).init()
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
    const stoppedTrace = (await agents.snapshot(alice.id, cancel.id)).trace.at(-1)!
    assert.equal(stoppedTrace.status, 'stopped')
    assert.match(stoppedTrace.text, /部分内容/)

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
    const failedEvents = await agents.events(failed.id)
    assert.equal(traceFromEvents(failedEvents, false).at(-1)?.status, 'error')
    const stoppedBeforeText: SessionEvent[] = failedEvents.map((event) =>
      event.type === 'turn/end'
        ? {
            ...event,
            data: { ...event.data, reason: { kind: 'aborted', reason: { kind: 'user' } } },
          }
        : event,
    )
    assert.equal(traceFromEvents(stoppedBeforeText, false).at(-1)?.status, 'stopped')

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

    const concurrent = Array.from({ length: 5 }, () => store.create(alice.id))
    await Promise.all(concurrent.map((item) => agents.start(alice.id, item.id, '持续生成')))
    assert.equal(agents.active.size, 5)
    await Promise.all(concurrent.map((item) => agents.stop(alice.id, item.id)))

    let steps = 0
    model.respond = () =>
      ++steps <= 25 ? toolChunks('list_files', {}) : textChunks('完成'.repeat(10001))
    const loop = store.create(alice.id)
    await agents.start(alice.id, loop.id, 'repeat')
    await agents.active.get(loop.id)?.done
    const completed = (await agents.snapshot(alice.id, loop.id)).messages.at(-1)!
    assert.equal(steps, 26)
    assert.ok(completed.role === 'assistant' && completed.status === 'done')
    assert.equal(
      completed.parts.filter((part) => part.type === 'tool' && part.status === 'done').length,
      25,
    )
    assert.ok(
      completed.parts.some((part) => part.type === 'text' && part.text === '完成'.repeat(10001)),
    )

    const longText = '资料'.repeat(100001)
    model.respond = () => [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: longText },
      { type: 'block-end', index: 0, block: { type: 'text', text: longText } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const long = store.create(alice.id)
    await agents.start(alice.id, long.id, '长资料')
    await agents.active.get(long.id)?.done
    model.respond = () => textChunks('继续完成')
    await agents.start(alice.id, long.id, '继续')
    await agents.active.get(long.id)?.done
    const continued = (await agents.snapshot(alice.id, long.id)).messages.at(-1)!
    assert.ok(continued.role === 'assistant' && continued.status === 'done')
    assert.ok(JSON.stringify(model.requests.at(-1)!.messages).includes(longText))
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
  let expectedMaxTokens = DEFAULT_MAX_TOKENS
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
      assert.equal(body.max_tokens, expectedMaxTokens)
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
      assert.deepEqual(body.system, [
        { type: 'text', text: 'x-anthropic-billing-header: cc_entrypoint=cli;' },
      ])
      assert.deepEqual(body.thinking, { type: 'disabled' })
    }
    assert.equal(body.tools[0].name, 'web_search')
    assert.equal(body.tools[0].max_uses, 5)
    assert.equal(body.max_tokens, 4096)
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
                    encrypted_content: isQianwen ? 'x'.repeat(1_000_001) : '',
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
    // Persist the previous release's cap, then resume through the application.
    expectedMaxTokens = 8192
    const legacy = await agents.ctx.agents.create({
      sessionId: SessionId(native.id),
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 8192 },
    })
    legacy.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: '旧配置' }], source: { kind: 'user' } }),
    )
    await legacy.agent.whenIdle()
    await legacy.dispose()
    expectedMaxTokens = DEFAULT_MAX_TOKENS
    await agents.start(user.id, native.id, '协议测试')
    await agents.active.get(native.id)?.done
    const nativeAnswer = (await agents.snapshot(user.id, native.id)).messages.at(-1)!
    assert.ok(nativeAnswer.role === 'assistant' && nativeAnswer.status === 'done')
    const publicTrace = JSON.stringify((await agents.snapshot(user.id, native.id)).trace)
    assert.ok(!publicTrace.includes('sig-official') && !publicTrace.includes('test-only'))
    assert.ok(
      nativeAnswer.parts.some((part) => part.type === 'text' && part.text === '原生适配器测试'),
    )
    await agents.start(user.id, native.id, '换千问继续', qianwen)
    await agents.active.get(native.id)?.done
    assert.deepEqual(received.at(-1), {
      provider: 'qianwen',
      model: qianwen.model,
      stream: true,
      users: 3,
    })
    await agents.close()
    agents = await new Agents(store).init()
    await agents.start(user.id, native.id, '重启继续')
    await agents.active.get(native.id)?.done
    assert.deepEqual(received.at(-1), {
      provider: 'qianwen',
      model: qianwen.model,
      stream: true,
      users: 4,
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
    dist: root,
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
    assert.equal((await fetch(base + '/bad%XX')).status, 404)
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
