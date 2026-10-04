import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { TestModel, textChunks, toolChunks } from '../tests/support/model.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { Store } from './store.ts'

async function fixture(t: TestContext, model: TestModel) {
  const root = await mkdtemp(join(tmpdir(), 'guance-retry-'))
  const store = new Store(root)
  let agents = await new Agents(store, { adapter: model }).init()
  const user = store.user('retry-owner', 'Test')
  const session = store.create(user.id)
  t.after(async () => {
    await agents.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    store,
    user,
    session,
    get agents() {
      return agents
    },
    async settle() {
      await agents.active.get(session.id)?.done
    },
    async reopen() {
      await agents.close()
      agents = await new Agents(store, { adapter: model }).init()
    },
  }
}

test('retry replaces the failed answer in place and preserves images, history and model', async (t) => {
  let failed = true
  const model = new TestModel(() => {
    if (failed) throw new Error('synthetic failure')
    return textChunks('recovered answer')
  })
  const f = await fixture(t, model)
  const selection = { provider: 'qianwen', model: 'deepseek-v4.1-flash' }
  await f.agents.start(f.user.id, f.session.id, 'original question', selection, [
    {
      mediaType: 'image/gif',
      data: 'R0lGODlhAQABAIAAAAAAAAAAACwAAAAAAQABAAACAkQBADs=',
    },
  ])
  await f.settle()
  const before = await f.agents.snapshot(f.user.id, f.session.id)
  const original = await f.agents.events(f.session.id)
  const quota = f.store.imageBytes(f.user.id)
  assert.equal(before.messages.at(-1)?.role, 'assistant')
  failed = false
  await f.agents.retry(f.user.id, f.session.id, 'turn-1')
  await f.settle()
  const after = await f.agents.snapshot(f.user.id, f.session.id)
  assert.equal(after.messages.length, 2)
  assert.deepEqual(after.messages[0], before.messages[0])
  const answer = after.messages[1]
  assert.ok(answer.role === 'assistant')
  assert.equal(answer.id, 'turn-1')
  assert.equal(answer.attemptId, 'turn-2')
  assert.equal(answer.status, 'done')
  assert.deepEqual(
    answer.questionImages,
    before.messages[0].role === 'user' ? before.messages[0].images : [],
  )
  assert.equal(f.store.imageBytes(f.user.id), quota)
  const request = model.requests.at(-1)!
  assert.equal(request.messages.filter((message) => message.role === 'user').length, 1)
  assert.equal(
    request.messages
      .filter((message) => message.role === 'user')[0]
      .content.filter((part) => part.type === 'image').length,
    1,
  )
  assert.equal(request.provider, selection.provider)
  assert.equal(request.model, selection.model)
  assert.deepEqual((await f.agents.events(f.session.id)).slice(0, original.length), original)
  await f.reopen()
  assert.deepEqual((await f.agents.snapshot(f.user.id, f.session.id)).messages, after.messages)
  await assert.rejects(f.agents.retry(f.user.id, f.session.id, 'turn-2'), { status: 409 })
})

test('failed retries stay retryable while stale and concurrent requests cannot add attempts', async (t) => {
  let fail = true
  const model = new TestModel(() => {
    if (fail) throw new Error('synthetic failure')
    return textChunks('done')
  })
  const f = await fixture(t, model)
  await f.agents.start(f.user.id, f.session.id, 'one question')
  await f.settle()
  const racing = await Promise.allSettled([
    f.agents.retry(f.user.id, f.session.id, 'turn-1'),
    f.agents.retry(f.user.id, f.session.id, 'turn-1'),
  ])
  assert.equal(racing.filter((result) => result.status === 'fulfilled').length, 1)
  await f.settle()
  assert.equal(model.requests.length, 2)
  await assert.rejects(f.agents.retry(f.user.id, f.session.id, 'turn-1'), { status: 409 })
  await assert.rejects(f.agents.retry('other-owner', f.session.id, 'turn-2'), { status: 404 })
  fail = false
  await f.agents.retry(f.user.id, f.session.id, 'turn-2')
  await f.settle()
  const after = await f.agents.snapshot(f.user.id, f.session.id)
  assert.equal(after.messages.length, 2)
  assert.equal(after.messages[1].id, 'turn-1')
  await f.agents.start(f.user.id, f.session.id, 'later question')
  await f.settle()
  const later = await f.agents.snapshot(f.user.id, f.session.id)
  assert.equal(later.messages.length, 4)
  assert.equal(later.messages[3].id, 'turn-4')
  await assert.rejects(f.agents.retry(f.user.id, f.session.id, 'turn-3'), { status: 409 })
})

test('retry retains generated artifacts and tool history without replaying tool effects', async (t) => {
  let calls = 0
  const model = new TestModel(() => {
    calls++
    if (calls === 1)
      return toolChunks('create_file', {
        name: 'retained',
        format: 'md',
        content: '# original artifact',
      })
    if (calls === 2) throw new Error('synthetic failure after tool')
    return textChunks('regenerated')
  })
  const f = await fixture(t, model)
  await f.agents.start(f.user.id, f.session.id, 'inspect files')
  await f.settle()
  const artifacts = f.store.artifacts(f.user.id, f.session.id)
  assert.equal(artifacts.length, 1)
  const bytes = await readFile(f.agents.files.path(artifacts[0].id))
  const old = await f.agents.events(f.session.id)
  await f.agents.retry(f.user.id, f.session.id, 'turn-1')
  await f.settle()
  const request = model.requests.at(-1)!
  assert.deepEqual(
    request.messages.map((message) => message.role),
    ['system', 'user'],
  )
  const view = await f.agents.snapshot(f.user.id, f.session.id)
  assert.equal(view.messages.length, 2)
  assert.equal(view.trace.filter((row) => row.kind === 'tool').length, 1)
  assert.equal(view.trace.find((row) => row.kind === 'tool')?.status, 'done')
  assert.deepEqual(view.artifacts, artifacts)
  assert.deepEqual(await readFile(f.agents.files.path(artifacts[0].id)), bytes)
  assert.deepEqual((await f.agents.events(f.session.id)).slice(0, old.length), old)
})

test('stopped partial output remains in trace while retry keeps the earlier conversation prefix', async (t) => {
  const model = new TestModel(() => textChunks('earlier answer'))
  const f = await fixture(t, model)
  await f.agents.start(f.user.id, f.session.id, 'earlier question')
  await f.settle()
  model.respond = () => 'hang'
  await f.agents.start(f.user.id, f.session.id, 'latest question')
  await new Promise<void>((resolve) => {
    const check = () => {
      if (
        f.agents.active.get(f.session.id)?.live?.chunks.some((chunk) => chunk.type === 'text-delta')
      ) {
        unsubscribe()
        resolve()
      }
    }
    const unsubscribe = f.agents.subscribe(f.user.id, f.session.id, check)
    check()
  })
  await f.agents.stop(f.user.id, f.session.id)
  const stopped = await f.agents.snapshot(f.user.id, f.session.id)
  model.respond = () => textChunks('regenerated answer')
  await f.agents.retry(f.user.id, f.session.id, 'turn-2')
  await f.settle()
  const after = await f.agents.snapshot(f.user.id, f.session.id)
  assert.equal(after.messages.length, 4)
  assert.deepEqual(after.messages.slice(0, 3), stopped.messages.slice(0, 3))
  assert.equal(after.messages[3].id, 'turn-2')
  assert.ok(after.trace.some((row) => row.text.includes('已经生成的部分内容')))
  const request = model.requests.at(-1)!
  assert.equal(request.messages.filter((message) => message.role === 'user').length, 2)
  assert.ok(JSON.stringify(request.messages).includes('earlier answer'))
  assert.ok(!JSON.stringify(request.messages).includes('已经生成的部分内容'))
  await f.reopen()
  assert.deepEqual((await f.agents.snapshot(f.user.id, f.session.id)).messages, after.messages)
})

test('retry works when failure occurred before the original user message was admitted', async (t) => {
  const model = new TestModel(() => textChunks('recovered'))
  let fail = true
  t.mock.method(model, 'resolveModel', async (provider: string, name: string) => {
    if (fail) throw new Error('synthetic model resolution failure')
    return { provider, id: name, name }
  })
  const f = await fixture(t, model)
  await f.agents.start(f.user.id, f.session.id, 'not yet admitted')
  await f.settle()
  assert.equal(
    (await f.agents.events(f.session.id)).filter((event) => event.type === 'user/message').length,
    0,
  )
  fail = false
  await f.agents.retry(f.user.id, f.session.id, 'turn-1')
  await f.settle()
  const after = await f.agents.snapshot(f.user.id, f.session.id)
  assert.equal(after.messages.length, 2)
  assert.equal(after.messages[1].id, 'turn-1')
  assert.equal(
    model.requests.at(-1)!.messages.filter((message) => message.role === 'user').length,
    1,
  )
})

test('a still-failed older answer cannot be retried after any later turn', async (t) => {
  const model = new TestModel(() => {
    throw new Error('synthetic old failure')
  })
  const f = await fixture(t, model)
  await f.agents.start(f.user.id, f.session.id, 'old failed question')
  await f.settle()
  model.respond = () => textChunks('later success')
  await f.agents.start(f.user.id, f.session.id, 'later successful question')
  await f.settle()
  await assert.rejects(f.agents.retry(f.user.id, f.session.id, 'turn-1'), { status: 409 })
  model.respond = () => {
    throw new Error('synthetic later failure')
  }
  await f.agents.start(f.user.id, f.session.id, 'latest failed question')
  await f.settle()
  const before = await f.agents.snapshot(f.user.id, f.session.id)
  assert.equal(before.messages[1].role === 'assistant' && before.messages[1].status, 'error')
  await assert.rejects(f.agents.retry(f.user.id, f.session.id, 'turn-1'), { status: 409 })
  assert.equal(model.requests.length, 3)
  assert.deepEqual((await f.agents.snapshot(f.user.id, f.session.id)).messages, before.messages)
  model.respond = () => textChunks('latest recovered')
  await f.agents.retry(f.user.id, f.session.id, 'turn-3')
  await f.settle()
  const after = await f.agents.snapshot(f.user.id, f.session.id)
  assert.equal(after.messages.length, 6)
  assert.deepEqual(after.messages.slice(0, 5), before.messages.slice(0, 5))
})

for (const started of [false, true])
  test(`restart resumes queued retry, turn started=${started}`, async (t) => {
    const model = new TestModel(() => {
      throw new Error('synthetic failure')
    })
    const f = await fixture(t, model)
    await f.agents.start(f.user.id, f.session.id, 'original question')
    await f.settle()
    const old = await f.agents.events(f.session.id)
    const question = old.find((event) => event.type === 'user/message')!
    assert.equal(question.type, 'user/message')
    const message = createUserMessage({
      content: question.data.content,
      source: { kind: 'guance-retry', answerId: 'turn-1', questionId: question.data.id },
    })
    // Exact durable prefix of followup(): input committed, next turn not started yet.
    const handle = await f.agents.ctx.sessionPersistence.open(SessionId(f.session.id), 'write')
    await handle.append([
      {
        seq: SessionSeq(old.length),
        time: Date.now(),
        type: 'agent/inbox/spliced',
        data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] },
      },
    ])
    if (started)
      await handle.append([
        {
          seq: SessionSeq(old.length + 1),
          time: Date.now(),
          type: 'turn/start',
          data: { turn: 2 },
        },
      ])
    await handle.close()
    await f.reopen()
    await assert.rejects(f.agents.start(f.user.id, f.session.id, 'must not drain queued retry'), {
      status: 409,
    })
    assert.equal(model.requests.length, 1)
    model.respond = () => textChunks('recovered once')
    await f.agents.retry(f.user.id, f.session.id, started ? 'turn-2' : 'turn-1')
    await f.settle()
    assert.equal(model.requests.length, 2)
    assert.equal(model.requests.at(-1)!.messages.filter((value) => value.role === 'user').length, 1)
    const after = await f.agents.snapshot(f.user.id, f.session.id)
    assert.equal(after.messages.length, 2)
    assert.equal(after.messages[1].id, 'turn-1')
    assert.equal(
      after.messages[1].role === 'assistant' && after.messages[1].attemptId,
      started ? 'turn-3' : 'turn-2',
    )
    await f.reopen()
    assert.deepEqual((await f.agents.snapshot(f.user.id, f.session.id)).messages, after.messages)
  })

test('stopping a retry before model admission retains the original context replacement anchor', async (t) => {
  const model = new TestModel(() => {
    throw new Error('synthetic failure')
  })
  const f = await fixture(t, model)
  await f.agents.start(f.user.id, f.session.id, 'original question')
  await f.settle()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.agents.ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.turn === 2) {
      entered.resolve()
      await release.promise
    }
    return next()
  })
  await f.agents.retry(f.user.id, f.session.id, 'turn-1')
  await entered.promise
  const stopping = f.agents.stop(f.user.id, f.session.id)
  release.resolve()
  await stopping
  assert.equal(model.requests.length, 1)
  model.respond = () => textChunks('recovered')
  await f.agents.retry(f.user.id, f.session.id, 'turn-2')
  await f.settle()
  assert.equal(model.requests.at(-1)!.messages.filter((value) => value.role === 'user').length, 1)
  const after = await f.agents.snapshot(f.user.id, f.session.id)
  assert.equal(after.messages.length, 2)
  assert.equal(after.messages[1].id, 'turn-1')
  await f.reopen()
  assert.deepEqual((await f.agents.snapshot(f.user.id, f.session.id)).messages, after.messages)
})

test('HTTP retry validates the attempt, retains ownership and never accepts replacement content', async (t) => {
  const model = new TestModel()
  const f = await fixture(t, model)
  await f.agents.start(f.user.id, f.session.id, '原位重试测试')
  await f.settle()
  const server = createApp(f.store, f.agents, {
    authenticate: async (request) => ({
      subject: request.headers['x-user'] === 'other' ? 'other' : 'retry-owner',
      name: 'Test',
    }),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const post = (input: unknown, user = 'owner') =>
    fetch(`http://127.0.0.1:${address.port}/api/sessions/${f.session.id}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user': user },
      body: JSON.stringify(input),
    })
  assert.equal((await post({ attemptId: '../../other' })).status, 400)
  assert.equal((await post({ attemptId: 'turn-1' }, 'other')).status, 404)
  assert.equal(
    (await post({ attemptId: 'turn-1', question: 'cannot replace original' })).status,
    202,
  )
  await f.settle()
  const view = await f.agents.snapshot(f.user.id, f.session.id)
  assert.equal(view.messages.length, 2)
  assert.equal(view.messages[0].role === 'user' && view.messages[0].text, '原位重试测试')
  assert.ok(view.messages[1].role === 'assistant' && view.messages[1].status === 'done')
})
