import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { TestModel, textChunks } from '../tests/support/model.ts'
import type { Session } from '../src/types/index.ts'
import { applySessionFrame, type SessionFrame } from '../src/services/session-stream.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { Store } from './store.ts'
import { messagesFromEvents } from './view.ts'

test('SSE sends history once, streams only changes, and reconnects with a current snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-stream-test-'))
  const store = new Store(root)
  const longText = 'x'.repeat(600_000)
  const model = new TestModel(() => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: longText },
    { type: 'block-end', index: 0, block: { type: 'text', text: longText } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const agents = await new Agents(store, { adapter: model }).init()
  const user = store.user('stream-test', 'Test')
  const session = store.create(user.id)
  const server = createApp(store, agents, {
    authenticate: async () => ({ subject: 'stream-test', name: 'Test' }),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  let reader: ReadableStreamDefaultReader<string> | undefined
  try {
    await agents.start(user.id, session.id, 'large output')
    await agents.active.get(session.id)?.done
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/sessions/${session.id}/events`,
    )
    reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    let pending = ''
    let current: Session | null = null
    const frames: SessionFrame[] = []
    const nextSnapshot = async () => {
      for (;;) {
        const boundary = pending.indexOf('\n\n')
        if (boundary >= 0) {
          const frame = pending.slice(0, boundary)
          pending = pending.slice(boundary + 2)
          if (frame.startsWith('data: ')) {
            const value = JSON.parse(frame.slice(6)) as SessionFrame
            frames.push(value)
            current = applySessionFrame(current, value)
            return current
          }
        } else {
          const chunk = await reader!.read()
          assert.equal(chunk.done, false, 'SSE must remain open after a large snapshot')
          pending += chunk.value
        }
      }
    }
    const first = await nextSnapshot()
    assert.ok(Buffer.byteLength(JSON.stringify(first)) > 1_000_000)
    model.respond = () => textChunks('latest state')
    await agents.start(user.id, session.id, 'continue')
    await agents.active.get(session.id)?.done
    let latest: Session
    do latest = await nextSnapshot()
    while (latest.running || latest.messages.length === first.messages.length)
    const answer = latest.messages.at(-1)
    assert.ok(answer?.role === 'assistant')
    assert.equal(answer.status, 'done')
    assert.ok(answer.parts.some((part) => part.type === 'text' && part.text === 'latest state'))
    assert.ok(
      frames.slice(1).every((frame) => 'changes' in frame && JSON.stringify(frame).length < 10000),
      'unchanged 1 MB history must not be sent again',
    )
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>())
    model.stream = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: longText }
      for (let i = 0; i < gates.length; i++) {
        await gates[i].promise
        if (i < gates.length - 1) yield { type: 'text-delta', index: 0, text: `追加${i}` }
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: longText + '追加0追加1追加2' },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await agents.start(user.id, session.id, 'incremental output')
    const lastText = (session: Session) => {
      const message = session.messages.at(-1)
      return message?.role === 'assistant'
        ? message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
        : ''
    }
    do latest = await nextSnapshot()
    while (lastText(latest) !== longText)
    for (let i = 0; i < gates.length - 1; i++) {
      gates[i].resolve()
      do latest = await nextSnapshot()
      while (!lastText(latest).endsWith(`追加${i}`))
      assert.ok(JSON.stringify(frames.at(-1)).length < 1000, 'only appended text crosses SSE')
    }
    gates.at(-1)!.resolve()
    await agents.active.get(session.id)?.done
    do latest = await nextSnapshot()
    while (latest.running)
    assert.deepEqual(latest, await agents.snapshot(user.id, session.id))
    await reader.cancel()
    const reconnected = await fetch(
      `http://127.0.0.1:${address.port}/api/sessions/${session.id}/events`,
    )
    reader = reconnected.body!.pipeThrough(new TextDecoderStream()).getReader()
    pending = ''
    current = null
    assert.deepEqual(await nextSnapshot(), latest)
    assert.ok('snapshot' in frames.at(-1)!)
  } finally {
    await reader?.cancel()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await agents.close()
    store.close()
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-stream-test-'),
    )
    await rm(root, { recursive: true })
  }
})

test('stream snapshots leave validated history untouched and check citations split across chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-stream-citation-'))
  const store = new Store(root)
  const model = new TestModel(() => textChunks('previous answer'))
  const agents = await new Agents(store, { adapter: model }).init()
  const user = store.user('stream-citation', 'Test')
  const session = store.create(user.id)
  const next = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  try {
    await agents.start(user.id, session.id, 'first question')
    await agents.active.get(session.id)?.done
    const prefix = 'New answer /api/library/passages/00000000-0000-'
    const suffix = '5000-a000-000000000000 continues'
    model.stream = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: prefix }
      await next.promise
      yield { type: 'text-delta', index: 0, text: suffix }
      await finish.promise
      yield { type: 'block-end', index: 0, block: { type: 'text', text: prefix + suffix } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await agents.start(user.id, session.id, 'continue')
    const run = agents.active.get(session.id)!
    const waitForChunks = (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (run.live?.chunks.filter((chunk) => chunk.type === 'text-delta').length === count) {
            unsubscribe()
            resolve()
          }
        }
        const unsubscribe = agents.subscribe(user.id, session.id, check)
        check()
      })
    await waitForChunks(1)
    const before = await agents.snapshot(user.id, session.id)
    const preserved = structuredClone(before.messages)
    const oldAnswer = before.messages[1]
    assert.ok(oldAnswer.role === 'assistant')
    for (const part of oldAnswer.parts) Object.freeze(part)
    next.resolve()
    await waitForChunks(2)
    const streamed = await agents.snapshot(user.id, session.id)
    assert.deepEqual(
      before.messages,
      preserved,
      'a later snapshot cannot rewrite the prior snapshot',
    )
    assert.deepEqual(
      streamed.messages,
      messagesFromEvents(await agents.events(session.id), true, run.live),
    )
    const answer = streamed.messages.at(-1)
    assert.ok(answer?.role === 'assistant')
    assert.equal(answer.parts.find((part) => part.type === 'text')?.text, 'New answer  continues')
    finish.resolve()
    await run.done
    const completed = await agents.snapshot(user.id, session.id)
    const finalAnswer = completed.messages.at(-1)
    assert.ok(finalAnswer?.role === 'assistant')
    assert.equal(
      finalAnswer.parts.find((part) => part.type === 'text')?.text,
      'New answer  continues',
    )
    assert.equal(finalAnswer.status, 'done')
  } finally {
    next.resolve()
    finish.resolve()
    await agents.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
