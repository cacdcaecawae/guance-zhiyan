import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SaveImageAttachment, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { TestModel, textChunks, toolChunks } from '../tests/support/model.ts'
import type { Session } from '../src/types/index.ts'
import { applySessionFrame, type SessionFrame } from '../src/services/session-stream.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { Store } from './store.ts'

async function openStream(url: string) {
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  let current: Session | null = null
  const read = async (): Promise<Session> => {
    for (;;) {
      const boundary = pending.indexOf('\n\n')
      if (boundary >= 0) {
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        if (frame.startsWith('data: ')) {
          current = applySessionFrame(current, JSON.parse(frame.slice(6)) as SessionFrame)
          return current
        }
      } else {
        const chunk = await reader.read()
        assert.equal(chunk.done, false)
        pending += chunk.value
      }
    }
  }
  return { read, close: () => reader.cancel() }
}

test('failed image admission clears running state for connected SSE subscribers and permits retry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-stream-failure-test-'))
  const store = new Store(root)
  const model = new TestModel(() => textChunks('retry completed'))
  const agents = await new Agents(store, { adapter: model }).init()
  const user = store.user('stream-failure-test', 'Test')
  const session = store.create(user.id)
  store.addImages(user.id, [{ attachmentId: 'test-quota', bytes: 200 * 2 ** 20 }], Infinity)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const attachments = agents.ctx.attachments as unknown as {
    saveCounted(
      inputs: readonly SaveImageAttachment[],
      count: (refs: readonly ImageAttachmentRef[]) => boolean,
      stopped: () => boolean,
    ): Promise<ImageAttachmentRef[] | undefined>
  }
  const saveCounted = attachments.saveCounted.bind(attachments)
  t.mock.method(attachments, 'saveCounted', async (...args: Parameters<typeof saveCounted>) => {
    entered.resolve()
    await release.promise
    return saveCounted(...args)
  })
  const server = createApp(store, agents, {
    authenticate: async () => ({ subject: 'stream-failure-test', name: 'Test' }),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/sessions/${session.id}`
  let stream: Awaited<ReturnType<typeof openStream>> | undefined
  const notifications: boolean[] = []
  const unsubscribe = agents.subscribe(user.id, session.id, () => {
    notifications.push(agents.active.has(session.id))
  })
  try {
    const request = fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'quota rejected',
        images: [
          {
            mediaType: 'image/gif',
            data: 'R0lGODlhAQABAIAAAAAAAAAAACwAAAAAAQABAAACAkQBADs=',
          },
        ],
      }),
    })
    await entered.promise
    stream = await openStream(`${base}/events`)
    const initial = await stream.read()
    assert.equal(initial.running, true, 'a reconnect may observe pending image admission')
    assert.deepEqual(initial.messages, [])
    release.resolve()
    const rejected = await request
    assert.equal(rejected.status, 413)
    assert.match(((await rejected.json()) as { error: string }).error, /图片空间已达上限/)
    const afterFailure = await agents.snapshot(user.id, session.id)
    assert.equal(afterFailure.running, false)
    assert.equal(model.requests.length, 0)
    assert.equal(notifications.at(-1), false, 'failed admission must notify existing subscribers')
    assert.deepEqual(await stream.read(), afterFailure)

    const retry = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'retry without image' }),
    })
    assert.equal(retry.status, 202)
    await agents.active.get(session.id)?.done
    let complete: Session
    do complete = await stream.read()
    while (complete.running || !complete.messages.length)
    assert.deepEqual(complete, await agents.snapshot(user.id, session.id))
    assert.equal(complete.messages.filter((message) => message.role === 'user').length, 1)
    assert.equal(model.requests.length, 1)
    assert.equal(
      notifications.filter((running) => !running).length,
      2,
      'failure and successful completion each publish one terminal notification',
    )
  } finally {
    release.resolve()
    unsubscribe()
    await stream?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await agents.close()
    store.close()
    assert.ok(root.startsWith(join(tmpdir(), 'gczy-stream-failure-test-')))
    await rm(root, { recursive: true })
  }
})

test('disconnect during a tool turn, reconnect, stop and retry preserve one copy of every message and result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-stream-lifecycle-test-'))
  const store = new Store(root)
  const model = new TestModel((request) =>
    request.messages.at(-1)?.role === 'tool' ? 'hang' : toolChunks('list_files', {}),
  )
  const agents = await new Agents(store, { adapter: model }).init()
  const user = store.user('stream-lifecycle-test', 'Test')
  const session = store.create(user.id)
  const server = createApp(store, agents, {
    authenticate: async () => ({ subject: 'stream-lifecycle-test', name: 'Test' }),
  })
  const disconnected = Promise.withResolvers<void>()
  server.on('request', (request, response) => {
    if (request.url?.endsWith('/events')) response.once('close', disconnected.resolve)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/sessions/${session.id}`
  let stream: Awaited<ReturnType<typeof openStream>> | undefined
  const post = (action: string, question?: string) =>
    fetch(`${base}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(question && { body: JSON.stringify({ question }) }),
    })
  try {
    stream = await openStream(`${base}/events`)
    assert.equal((await stream.read()).running, false)
    assert.equal((await post('messages', 'inspect files then keep generating')).status, 202)
    let view: Session
    do view = await stream.read()
    while (!JSON.stringify(view.messages).includes('已经生成的部分内容'))
    assert.equal(view.running, true)
    const beforeDisconnect = structuredClone(view)
    await stream.close()
    await disconnected.promise
    assert.equal(agents.listeners.has(session.id), false, 'disconnect releases the subscription')
    assert.equal(agents.active.has(session.id), true, 'disconnect does not silently stop work')

    stream = await openStream(`${base}/events`)
    assert.deepEqual(await stream.read(), beforeDisconnect)
    assert.equal((await post('stop')).status, 200)
    do view = await stream.read()
    while (view.running)
    const answer = view.messages.at(-1)
    assert.ok(answer?.role === 'assistant' && answer.status === 'stopped')
    assert.ok(
      answer.startedAt !== undefined && answer.endedAt !== undefined,
      'the answer carries its turn start and end times',
    )
    assert.ok(answer.endedAt >= answer.startedAt)
    assert.equal(view.messages.length, 2)
    assert.equal(answer.parts.filter((part) => part.type === 'text').length, 1)
    const tools = answer.parts.filter((part) => part.type === 'tool')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].status, 'done')
    assert.equal(view.trace.filter((row) => row.kind === 'tool').length, 1)
    assert.deepEqual(view, await agents.snapshot(user.id, session.id))

    model.respond = () => textChunks('retry completed')
    assert.equal((await post('messages', 'retry now')).status, 202)
    await agents.active.get(session.id)?.done
    do view = await stream.read()
    while (view.running || view.messages.length < 4)
    assert.equal(view.messages.length, 4)
    assert.deepEqual(view.messages.slice(0, 2), [beforeDisconnect.messages[0], answer])
    assert.equal(new Set(view.messages.map((message) => message.id)).size, 4)
    assert.equal(view.trace.filter((row) => row.kind === 'tool').length, 1)
    assert.deepEqual(view, await agents.snapshot(user.id, session.id))
    assert.equal(model.requests.length, 3)
  } finally {
    await stream?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await agents.close()
    store.close()
    assert.ok(root.startsWith(join(tmpdir(), 'gczy-stream-lifecycle-test-')))
    await rm(root, { recursive: true })
  }
})
