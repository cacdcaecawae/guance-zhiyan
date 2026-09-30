import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { TestModel, textChunks, toolChunks } from '../tests/support/model.ts'
import { Agents } from './agent.ts'
import { Store } from './store.ts'

const providers = [
  { provider: 'deepseek-official', model: 'deepseek-flash' },
  { provider: 'qianwen', model: 'deepseek-v4.1-flash' },
]

for (const selection of providers)
  for (const outcome of ['headers', 'body', 'success', 'stop'] as const)
    test(`${selection.provider} search: ${outcome} keeps the declared timeout and cancellation semantics`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'gczy-search-timeout-test-'))
      const saved = Object.fromEntries(
        ['DEEPSEEK_API_KEY', 'DEEPSEEK_SEARCH_BASE_URL', 'QIANWEN_API_KEY', 'QIANWEN_BASE_URL'].map(
          (key) => [key, process.env[key]],
        ),
      )
      const received = Promise.withResolvers<void>()
      const server = createServer((request, response) => {
        request.resume()
        if (outcome === 'success') {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(
            JSON.stringify({
              content: [
                {
                  type: 'web_search_tool_result',
                  tool_use_id: 'search-test',
                  content: [
                    {
                      type: 'web_search_result',
                      url: 'https://example.org/source',
                      title: '测试来源',
                      encrypted_content: '',
                    },
                  ],
                },
              ],
            }),
          )
        } else if (outcome !== 'headers') {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.write('{"content":[') // Response headers arrive, but JSON never completes.
        }
        received.resolve()
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const base = `http://127.0.0.1:${address.port}`
      process.env.DEEPSEEK_API_KEY = 'search-timeout-test-only'
      process.env.DEEPSEEK_SEARCH_BASE_URL = base
      process.env.QIANWEN_API_KEY = 'search-timeout-test-only'
      process.env.QIANWEN_BASE_URL = base
      const store = new Store(root)
      const model = new TestModel((request) =>
        request.messages.at(-1)?.role === 'tool'
          ? textChunks('搜索调用已结束。')
          : toolChunks('web_search', { queries: ['受控测试'] }),
      )
      const agents = await new Agents(store, { adapter: model }).init()
      const user = store.user('timeout-test', 'Test')
      const session = store.create(user.id)
      const realTimeout = globalThis.setTimeout
      let guard: ReturnType<typeof setTimeout> | undefined
      t.mock.timers.enable({ apis: ['setTimeout'] })
      try {
        await agents.start(user.id, session.id, '测试搜索', selection)
        const run = agents.active.get(session.id)!
        await received.promise
        assert.equal(agents.ctx.tools.get('web_search', run.handle!.agent)?.timeoutMs, 30_000)
        assert.equal(agents.ctx.tools.get('create_file', run.handle!.agent)?.timeoutMs, undefined)
        if (outcome === 'stop') await agents.stop(user.id, session.id)
        else if (outcome !== 'success') {
          t.mock.timers.tick(29_999)
          assert.equal(agents.active.has(session.id), true, 'the search retains its full budget')
          t.mock.timers.tick(1)
        }
        await Promise.race([
          run.done,
          new Promise<never>((_, reject) => {
            guard = realTimeout(
              () => reject(new Error('search did not settle after cancellation')),
              3000,
            )
          }),
        ])
        const snapshot = await agents.snapshot(user.id, session.id)
        assert.equal(snapshot.running, false)
        const answer = snapshot.messages.at(-1)
        assert.ok(answer?.role === 'assistant')
        const part = answer.parts.find((item) => item.type === 'tool')
        assert.ok(part?.type === 'tool')
        const result = (await agents.events(session.id)).find(
          (event) => event.type === 'tool/result',
        )
        assert.ok(result?.type === 'tool/result')
        if (outcome === 'success') {
          assert.equal(part.status, 'done')
          assert.match(part.output, /https:\/\/example.org\/source/)
          assert.equal(result.data.error, undefined)
        } else if (outcome === 'stop') {
          assert.equal(answer.status, 'stopped')
          assert.notEqual(result.data.error?.code, 'TOOL_TIMEOUT')
          assert.doesNotMatch(part.output, /超时/)
        } else {
          assert.equal(part.status, 'error')
          assert.equal(result.data.error?.code, 'TOOL_TIMEOUT')
          assert.equal(part.output, '工具执行超时，请重试或更换来源。')
          assert.equal(answer.status, 'done', 'a tool timeout does not impose a whole-turn cap')
          assert.equal(model.requests.length, 2, 'the model receives the failed tool result')
        }
      } finally {
        t.mock.timers.reset()
        clearTimeout(guard)
        await agents.stop(user.id, session.id)
        await agents.close()
        store.close()
        server.closeAllConnections()
        await new Promise<void>((done) => server.close(() => done()))
        for (const [key, value] of Object.entries(saved))
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        assert.ok(
          resolve(root).startsWith(resolve(tmpdir()) + sep) &&
            root.includes('gczy-search-timeout-test-'),
        )
        await rm(root, { recursive: true })
      }
    })
