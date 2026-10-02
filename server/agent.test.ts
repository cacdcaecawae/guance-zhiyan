import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, chmod, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_MAX_TOKENS } from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Session } from '../src/types/index.ts'
import { traceFromEvents } from './trace.ts'
import { messagesFromEvents, toolInput, toolError } from './view.ts'
import { TestModel, textChunks, toolChunks } from '../tests/support/model.ts'
import { Store } from './store.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { modelAdapter } from './models.ts'

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
    // 用户停止时中断的工具记为“已中断”，不算失败
    assert.ok(
      projected[0].role === 'assistant' &&
        projected[0].parts.some((part) => part.type === 'tool' && part.status === 'stopped'),
    )
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

test('all catalog models accept images; official Flash keeps in-history system updates', async () => {
  for (const [provider, model] of [
    ['deepseek-official', 'deepseek-flash'],
    ['deepseek-official', 'deepseek-v4-pro'],
    ['qianwen', 'deepseek-v4.1-flash'],
    ['qianwen', 'deepseek-v4-pro-0813'],
  ]) {
    const info = await modelAdapter(provider, () => undefined).resolveModel(provider, model)
    assert.deepEqual(info.inputModalities, ['text', 'image'])
    assert.equal(info.systemPromptUpdate, model === 'deepseek-flash' ? 'in-history' : undefined)
  }
})

test('HTTP: authentication, ownership, request boundaries and file download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-http-test-'))
  const store = new Store(root)
  const model = new TestModel(() => textChunks('hello'))
  const agents = await new Agents(store, { adapter: model }).init()
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
    const ask = (body: object) =>
      fetch(`${base}/api/sessions/${id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    assert.equal((await ask({ question: '', images: [] })).status, 400)
    // 伪造已存附件引用会被结构校验拒绝
    const forged = await ask({
      question: '看图',
      images: [{ type: 'file', attachment: { attachmentId: 'sha256:0', name: 'x', bytes: 1 } }],
    })
    assert.equal(forged.status, 400)
    const broken = await ask({
      question: '',
      images: [{ mediaType: 'image/png', data: '不是图片' }],
    })
    assert.equal(broken.status, 400)
    assert.match(((await broken.json()) as { error: string }).error, /图片/)
    const sent = await ask({
      question: '',
      images: [{ mediaType: 'image/png', data: png, name: '截图.png' }],
    })
    assert.equal(sent.status, 202)
    await agents.active.get(id)?.done
    const asked = model.requests.at(-1)!.messages.findLast((message) => message.role === 'user')!
    assert.ok(asked.content.some((block) => block.type === 'image'))
    const view = (await (await fetch(`${base}/api/sessions/${id}`, { headers })).json()) as Session
    const question = view.messages.findLast((message) => message.role === 'user')!
    assert.ok(question.role === 'user' && question.images?.length === 1)
    assert.equal(question.text, '')
    assert.deepEqual(
      { ...question.images[0], id: '' },
      { id: '', name: '截图.png', width: 1, height: 1 },
    )
    const imagePath = `/images/${encodeURIComponent(question.images[0].id)}`
    const picture = await fetch(`${base}/api/sessions/${id}${imagePath}`, { headers })
    assert.equal(picture.status, 200)
    assert.match(picture.headers.get('content-type')!, /^image\//)
    assert.equal(picture.headers.get('cache-control'), 'no-store', 'every read is checked again')
    assert.ok((await picture.arrayBuffer()).byteLength > 0)
    // 附图按人累计计入配额：超额时整条附图提问被拒、不记账，纯文字提问不受影响
    const alice = store.user('alice', 'Test')
    assert.ok(store.imageBytes(alice.id) > 0, 'the stored image is counted')
    store.addImages(alice.id, [{ attachmentId: 'test-filler', bytes: 200 * 2 ** 20 }], Infinity)
    const used = store.imageBytes(alice.id)
    const full = await ask({
      question: '再看一张',
      images: [{ mediaType: 'image/png', data: png }],
    })
    assert.equal(full.status, 413)
    assert.match(((await full.json()) as { error: string }).error, /图片空间已达上限/)
    assert.equal(store.imageBytes(alice.id), used)
    assert.equal((await ask({ question: '只问文字' })).status, 202)
    await agents.active.get(id)?.done
    const other = (await (
      await fetch(base + '/api/sessions', { method: 'POST', headers })
    ).json()) as { id: string }
    for (const [user, session] of [
      ['bob', id],
      ['alice', other.id],
    ])
      assert.equal(
        (
          await fetch(`${base}/api/sessions/${session}${imagePath}`, {
            headers: { 'x-test-user': user },
          })
        ).status,
        404,
      )
    // 重新提问只引用本会话已有的图片：满额时也能发送，不重新入库、不重复计入配额；
    // 没在本会话提问中出现过的 id（包括其他会话的图片）一律视为不存在
    const again = await ask({ question: '', images: [{ id: question.images[0].id }] })
    assert.equal(again.status, 202)
    await agents.active.get(id)?.done
    assert.equal(store.imageBytes(alice.id), used)
    const reasked = model.requests.at(-1)!.messages.findLast((message) => message.role === 'user')!
    assert.deepEqual(
      reasked.content.flatMap((block) =>
        block.type === 'image' ? [block.attachment.attachmentId] : [],
      ),
      [question.images[0].id],
    )
    for (const [session, image] of [
      [id, `sha256:${'0'.repeat(64)}`],
      [other.id, question.images[0].id],
    ])
      assert.equal(
        (
          await fetch(`${base}/api/sessions/${session}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ question: '', images: [{ id: image }] }),
          })
        ).status,
        404,
      )
    const download = await fetch(`${base}/api/files/${file.id}`, { headers })
    assert.equal(await download.text(), '# 内容')
    assert.match(download.headers.get('content-disposition')!, /attachment/)
    for (const name of ["O'Reilly 研究.md", '研究(2026).md', '研究*.md', '研究%20.md']) {
      const named = await agents.files.save(alice.id, id, name, Buffer.from('合成文件正文'))
      const response = await fetch(`${base}/api/files/${named.id}`, { headers })
      const value = /filename\*=UTF-8''([^;]*)$/.exec(
        response.headers.get('content-disposition')!,
      )?.[1]
      assert.ok(value)
      // RFC 8187 value-chars: attr-char or a percent-encoded byte.
      assert.match(value, /^(?:[A-Za-z0-9!#$&+.^_`|~-]|%[0-9A-Fa-f]{2})+$/)
      assert.equal(decodeURIComponent(value), name)
      assert.equal(await response.text(), '合成文件正文')
    }
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

test('HTTP: rename, pin and delete sessions; deletion clears history and files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-session-actions-test-'))
  const store = new Store(root)
  let hang = false
  const model = new TestModel(() => (hang ? 'hang' : textChunks('好的')))
  const agents = await new Agents(store, { adapter: model }).init()
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
  const call = (method: string, path: string, body?: object, user = 'alice') =>
    fetch(base + path, {
      method,
      headers: { 'x-test-user': user, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    })
  const list = async () =>
    (await (await call('GET', '/api/sessions')).json()) as { title: string; pinned: boolean }[]
  try {
    const sessions = []
    for (const title of ['第一', '第二']) {
      const { id } = (await (await call('POST', '/api/sessions')).json()) as { id: string }
      assert.equal(
        (await call('PATCH', `/api/sessions/${id}`, { title: ` ${title} ` })).status,
        200,
      )
      sessions.push(id)
    }
    const [first, second] = sessions
    assert.deepEqual(await list(), [
      { id: second, title: '第二', pinned: false },
      { id: first, title: '第一', pinned: false },
    ])
    for (const body of [
      {},
      { title: ' ' },
      { title: '长'.repeat(81) },
      { title: '换\n行' },
      { title: 1 },
      { pinned: 'yes' },
    ])
      assert.equal((await call('PATCH', `/api/sessions/${first}`, body)).status, 400)
    assert.equal(
      (await call('PATCH', `/api/sessions/${first}`, { title: '他人' }, 'bob')).status,
      404,
    )
    // 置顶的排在前面，越晚置顶越靠前；取消置顶回到创建顺序
    const pinned = await call('PATCH', `/api/sessions/${first}`, { pinned: true })
    assert.deepEqual(await pinned.json(), { id: first, title: '第一', pinned: true })
    assert.deepEqual(
      (await list()).map((session) => session.title),
      ['第一', '第二'],
    )
    await call('PATCH', `/api/sessions/${second}`, { pinned: true })
    assert.deepEqual(
      (await list()).map((session) => session.title),
      ['第二', '第一'],
    )
    await call('PATCH', `/api/sessions/${second}`, { pinned: false })
    assert.deepEqual(
      (await list()).map((session) => [session.title, session.pinned]),
      [
        ['第一', true],
        ['第二', false],
      ],
    )
    // 已有标题的会话提问后不再被问题覆盖
    assert.equal(
      (await call('POST', `/api/sessions/${first}/messages`, { question: '问题' })).status,
      202,
    )
    await agents.active.get(first)?.done
    assert.equal(store.session(store.user('alice', 'Test').id, first).title, '第一')

    const alice = store.user('alice', 'Test').id
    const file = await agents.files.create(alice, first, '报告', 'md', '# 内容')
    const history = (await readdir(join(root, 'sessions'), { recursive: true })).filter((path) =>
      path.includes(first),
    )
    assert.ok(history.length, 'the question was persisted')
    hang = true
    assert.equal(
      (await call('POST', `/api/sessions/${second}/messages`, { question: '等' })).status,
      202,
    )
    const running = await call('DELETE', `/api/sessions/${second}`)
    assert.equal(running.status, 409)
    assert.match(((await running.json()) as { error: string }).error, /请先停止/)
    await call('POST', `/api/sessions/${second}/stop`)
    assert.equal((await call('DELETE', `/api/sessions/${first}`, undefined, 'bob')).status, 404)
    assert.equal((await call('GET', `/api/sessions/${first}`)).status, 200, 'others cannot delete')

    // 数据目录里多出的普通文件不影响清理历史
    await writeFile(join(root, 'sessions', 'stray.txt'), '')
    // 正在查看该会话的连接收到“已删除”，而不是提示重新连接
    const stream = await fetch(`${base}/api/sessions/${first}/events`, {
      headers: { 'x-test-user': 'alice' },
    })
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader()
    assert.match((await reader.read()).value!, /snapshot/)
    assert.equal((await call('DELETE', `/api/sessions/${first}`)).status, 200)
    let received = ''
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
      received += chunk.value
    assert.match(received, /event: deleted/)
    assert.deepEqual(
      (await list()).map((session) => session.title),
      ['第二'],
    )
    for (const path of [`/api/sessions/${first}`, `/api/files/${file.id}`])
      assert.equal((await call('GET', path)).status, 404)
    assert.equal((await call('DELETE', `/api/sessions/${first}`)).status, 404)
    assert.deepEqual(
      (await readdir(join(root, 'sessions'), { recursive: true })).filter((path) =>
        path.includes(first),
      ),
      [],
      'message history is removed',
    )
    await assert.rejects(stat(agents.files.path(file.id)), { code: 'ENOENT' })
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE session_id=?').get(first)!.n,
      0,
    )
    // 停止后的会话可以删除
    assert.equal((await call('DELETE', `/api/sessions/${second}`)).status, 200)
    assert.deepEqual(await list(), [])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    await agents.close()
    store.close()
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + sep) &&
        root.includes('gczy-session-actions-test-'),
    )
    await rm(root, { recursive: true })
  }
})

test('session deletion reclaims the sandbox first and keeps everything when that fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-session-removal-test-'))
  const store = new Store(root)
  let discarding = Promise.withResolvers<void>()
  const sandboxes = { discard: () => discarding.promise, close: async () => {} }
  const agents = await new Agents(store, {
    adapter: new TestModel(() => textChunks('好的')),
    sandboxes: sandboxes as never,
  }).init()
  try {
    const user = store.user('removal', 'Test').id
    const { id } = store.create(user)
    const removal = agents.remove(user, id)
    // 回收期间不能再提问，也不能重复删除
    await assert.rejects(agents.start(user, id, '问题'), { status: 409 })
    await assert.rejects(agents.remove(user, id), { status: 409 })
    discarding.reject(new Error('kill failed'))
    await assert.rejects(removal, { status: 503 })
    assert.equal(store.session(user, id).id, id, 'the session survives a failed reclaim')
    // 未回收的实例记录是重启后回收的唯一线索：不随会话删除
    store.db.prepare('INSERT INTO sandboxes(session_id, remote_id) VALUES(?, ?)').run(id, 'remote')
    discarding = Promise.withResolvers<void>()
    discarding.resolve()
    await assert.rejects(agents.remove(user, id), { status: 503 })
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sandboxes').get()!.n, 1)
    store.db.prepare('DELETE FROM sandboxes').run()
    await agents.remove(user, id)
    assert.throws(() => store.session(user, id), { status: 404 })
  } finally {
    await agents.close()
    store.close()
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + sep) &&
        root.includes('gczy-session-removal-test-'),
    )
    await rm(root, { recursive: true })
  }
})

test('question images count by their stored size and are never written past the quota', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-quota-test-'))
  const store = new Store(root)
  const agents = await new Agents(store, {
    adapter: new TestModel(() => textChunks('ok')),
  }).init()
  try {
    const user = store.user('quota-test', 'Test')
    const session = store.create(user.id)
    const limit = 200 * 2 ** 20
    // 1×1 黑色 GIF 上传只有 35 字节，规范化后存成更大的 JPEG
    const gif = {
      mediaType: 'image/gif' as const,
      data: 'R0lGODlhAQABAIAAAAAAAAAAACwAAAAAAQABAAACAkQBADs=',
    }
    const saved = () =>
      readdir(join(root, 'dsh', 'attachments'), { recursive: true }).catch(() => [])
    store.addImages(user.id, [{ attachmentId: 'filler', bytes: limit - 100 }], limit)
    const before = await saved()
    await assert.rejects(agents.start(user.id, session.id, '', undefined, [gif]), { status: 413 })
    assert.equal(store.imageBytes(user.id), limit - 100, 'a refused image is not counted')
    assert.deepEqual(await saved(), before, 'a refused image is not written')
    store.db.prepare("UPDATE images SET bytes=? WHERE id='filler'").run(limit - 10_000)
    // 两张图保存后都比上传时大；同样的图再发一次不重复计入
    const dot = {
      mediaType: 'image/gif' as const,
      data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    }
    for (const question of ['第一次', '同样的图再发一次']) {
      await agents.start(user.id, session.id, question, undefined, [gif, dot])
      await agents.active.get(session.id)?.done
    }
    const images = (await agents.snapshot(user.id, session.id)).messages
      .flatMap((message) => (message.role === 'user' ? (message.images ?? []) : []))
      .slice(0, 2)
    const sizes = await Promise.all(
      images.map(async ({ id }) => (await agents.image(user.id, session.id, id)).data.byteLength),
    )
    assert.ok(sizes[0] > 100, 'the stored image is larger than the room left before')
    const counted = limit - 10_000 + sizes[0] + sizes[1]
    assert.equal(store.imageBytes(user.id), counted, 'counted once, by stored size')
    // 重新提问引用已存的图片，不再上传转换后更大的图，也不重复计入
    await agents.start(
      user.id,
      session.id,
      '',
      undefined,
      images.map(({ id }) => ({ id })),
    )
    await agents.active.get(session.id)?.done
    assert.equal(store.imageBytes(user.id), counted)
  } finally {
    await agents.close()
    store.close()
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-quota-test-'),
    )
    await rm(root, { recursive: true })
  }
})

test('HTTP: only a signed-in question may take longer than 30 seconds to upload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-http-test-'))
  const store = new Store(root)
  const agents = await new Agents(store, {
    adapter: new TestModel(() => textChunks('hello')),
  }).init()
  const server = createApp(store, agents, {
    authenticate: async (req) =>
      req.headers['x-test-user'] === 'alice' ? { subject: 'alice', name: 'Test' } : undefined,
  })
  const accepted: Socket[] = []
  server.on('connection', (socket: Socket) => accepted.push(socket))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const { port } = address
  const { id } = store.create(store.user('alice', 'Test').id)
  // 只发请求头、不发正文，收到第一段回应后再推进时钟
  const upload = async (headers: string) => {
    const socket = connect(port, '127.0.0.1')
    socket.write(
      `POST /api/sessions/${id}/messages HTTP/1.1\r\nHost: test\r\nContent-Type: application/json\r\nContent-Length: 16\r\n${headers}\r\n`,
    )
    const [reply] = await once(socket, 'data')
    return { socket, reply: String(reply), accepted: accepted.at(-1)! }
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const stranger = await upload('')
    assert.match(stranger.reply, /^HTTP\/1\.1 401/)
    assert.ok(!stranger.accepted.destroyed)
    t.mock.timers.tick(30000)
    assert.ok(stranger.accepted.destroyed, 'an unfinished request is closed after 30 seconds')
    stranger.socket.destroy()
    // 客户端收到 100 Continue 时，处理函数已在同一轮事件中完成登录与会话归属检查、进入提问路由
    const alice = await upload('x-test-user: alice\r\nExpect: 100-continue\r\n')
    assert.match(alice.reply, /^HTTP\/1\.1 100/)
    t.mock.timers.tick(30000)
    assert.ok(!alice.accepted.destroyed, 'a signed-in question keeps uploading')
    alice.socket.write('{"question":" "}')
    const [reply] = await once(alice.socket, 'data')
    assert.match(String(reply), /^HTTP\/1\.1 400/)
    alice.socket.destroy()
  } finally {
    t.mock.timers.reset()
    server.closeAllConnections()
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    await agents.close()
    store.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-http-test-'))
    await rm(root, { recursive: true })
  }
})
