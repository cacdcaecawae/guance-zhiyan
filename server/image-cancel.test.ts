import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore, { prepareImageFile } from '@deepseek-ai/dsh-attachment-local'
import { TestModel, textChunks } from '../tests/support/model.ts'
import { Store } from './store.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'

const gif = {
  mediaType: 'image/gif' as const,
  data: 'R0lGODlhAQABAIAAAAAAAAAAACwAAAAAAQABAAACAkQBADs=',
}
const dot = {
  mediaType: 'image/gif' as const,
  data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'gczy-image-cancel-'))
  const store = new Store(root)
  const model = new TestModel(() => textChunks('ok'))
  const agents = await new Agents(store, { adapter: model }).init()
  const user = store.user('image-cancel-test', 'Test')
  const session = store.create(user.id)
  t.after(async () => {
    await agents.close()
    store.close()
    assert.ok(root.startsWith(join(tmpdir(), 'gczy-image-cancel-')))
    await rm(root, { recursive: true })
  })
  return {
    root,
    store,
    model,
    agents,
    user,
    session,
    // Expose only the normalization boundary needed for deterministic cancellation, without delays.
    attachments: agents.ctx.attachments as unknown as Pick<
      LocalAttachmentStore,
      'imageLimits' | 'normalizationPolicy'
    > & { validateImageBatch(inputs: readonly SaveImageAttachment[]): void },
    files: () => readdir(join(root, 'dsh', 'attachments'), { recursive: true }).catch(() => []),
  }
}

test('an immediate stop cancels queued images without using the last available quota', async (t) => {
  const { store, model, agents, user, session, attachments, files } = await fixture(t)
  const next = await prepareImageFile(
    { ...dot, data: Buffer.from(dot.data, 'base64') },
    attachments.imageLimits,
    attachments.normalizationPolicy,
  )
  const limit = 200 * 2 ** 20
  store.addImages(user.id, [{ attachmentId: 'filler', bytes: limit - next.ref.bytes }], limit)
  const count = t.mock.method(store, 'addImages')
  const validate = t.mock.method(attachments, 'validateImageBatch')
  const notifications: boolean[] = []
  agents.subscribe(user.id, session.id, () => notifications.push(agents.active.has(session.id)))
  const starting = agents.start(user.id, session.id, '取消图片', undefined, [gif])
  await agents.stop(user.id, session.id)
  await starting
  assert.equal(count.mock.callCount(), 0)
  assert.equal(validate.mock.callCount(), 0, 'a cancelled queue entry is not normalized')
  assert.equal(store.imageBytes(user.id), limit - next.ref.bytes)
  assert.deepEqual(await files(), [])
  assert.deepEqual((await agents.snapshot(user.id, session.id)).messages, [])
  assert.equal(model.requests.length, 0)
  assert.equal(notifications.at(-1), false, 'subscribers see admission finish')

  await agents.start(user.id, session.id, '新的图片', undefined, [dot])
  await agents.active.get(session.id)?.done
  assert.equal(store.imageBytes(user.id), limit)
  assert.equal(model.requests.length, 1, 'a cancelled batch does not poison the queue or quota')
})

for (const action of ['stop', 'close'] as const)
  test(`${action} during normalization discards the whole uncounted image batch`, async (t) => {
    const { store, model, agents, user, session, attachments, files } = await fixture(t)
    let stopping: Promise<void> | undefined
    const validate = attachments.validateImageBatch.bind(attachments)
    t.mock.method(
      attachments,
      'validateImageBatch',
      (...args: Parameters<typeof validate>) => {
        validate(...args)
        // Runs after prepareImageFile starts, before its asynchronous metadata read returns.
        queueMicrotask(() => {
          stopping = action === 'stop' ? agents.stop(user.id, session.id) : agents.close()
        })
      },
      { times: 1 },
    )
    const count = t.mock.method(store, 'addImages')
    await agents.start(user.id, session.id, '取消整批图片', undefined, [gif, dot])
    assert.ok(stopping)
    await stopping
    assert.equal(count.mock.callCount(), 0)
    assert.equal(store.imageBytes(user.id), 0)
    assert.deepEqual(await files(), [])
    assert.equal(agents.active.size, 0)
    assert.equal(model.requests.length, 0)
  })

test('a cancelled batch waiting behind another commit neither charges nor blocks later uploads', async (t) => {
  const { store, model, agents, user, session, attachments } = await fixture(t)
  const cancelled = store.create(user.id)
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  const count = store.addImages.bind(store)
  t.mock.method(
    store,
    'addImages',
    (...args: Parameters<typeof count>) => {
      const accepted = count(...args)
      starting = agents.start(user.id, cancelled.id, '队列中取消', undefined, [dot])
      stopping = agents.stop(user.id, cancelled.id)
      return accepted
    },
    { times: 1 },
  )
  const validate = t.mock.method(attachments, 'validateImageBatch')
  await agents.start(user.id, session.id, '第一批', undefined, [gif])
  assert.ok(starting && stopping)
  await Promise.all([starting, stopping, agents.active.get(session.id)?.done])
  assert.equal(validate.mock.callCount(), 1)
  const used = store.imageBytes(user.id)
  assert.ok(used > 0)
  assert.deepEqual((await agents.snapshot(user.id, cancelled.id)).messages, [])
  assert.equal(model.requests.length, 1)

  await agents.start(user.id, cancelled.id, '队列恢复后', undefined, [dot])
  await agents.active.get(cancelled.id)?.done
  assert.equal(validate.mock.callCount(), 2)
  assert.ok(store.imageBytes(user.id) > used)
  assert.equal(model.requests.length, 2)
})

for (const action of ['stop', 'close'] as const)
  test(`${action} after quota commit retains every image and its question without invoking the model`, async (t) => {
    const { store, model, agents, user, session } = await fixture(t)
    let stopping: Promise<void> | undefined
    const count = store.addImages.bind(store)
    t.mock.method(
      store,
      'addImages',
      (...args: Parameters<typeof count>) => {
        const accepted = count(...args)
        assert.equal(accepted, true)
        // The quota is committed, but neither image has been written yet.
        stopping = action === 'stop' ? agents.stop(user.id, session.id) : agents.close()
        return accepted
      },
      { times: 1 },
    )
    await agents.start(user.id, session.id, '保留图片提问', undefined, [gif, dot])
    assert.ok(stopping)
    await stopping
    assert.equal(model.requests.length, 0)
    assert.equal(agents.active.size, 0)
    const used = store.imageBytes(user.id)
    assert.ok(used > 0)
    await agents.close()

    // Read the durable history with a new runtime; live state cannot hide a lost reference.
    const reopened = await new Agents(store, { adapter: model }).init()
    try {
      const view = await reopened.snapshot(user.id, session.id)
      assert.equal(view.running, false)
      assert.equal(view.messages.length, 1)
      const question = view.messages[0]
      assert.ok(question.role === 'user')
      assert.equal(question.text, '保留图片提问')
      assert.equal(question.images?.length, 2)
      const images = question.images!
      const sizes = await Promise.all(
        images.map(
          async ({ id }) => (await reopened.image(user.id, session.id, id)).data.byteLength,
        ),
      )
      assert.equal(
        sizes.reduce((sum, size) => sum + size, 0),
        used,
      )
      await reopened.start(
        user.id,
        session.id,
        '重新提问',
        undefined,
        images.map(({ id }) => ({ id })),
      )
      await reopened.active.get(session.id)?.done
      assert.equal(
        store.imageBytes(user.id),
        used,
        'retained references are reusable without recharge',
      )
      assert.equal(model.requests.length, 1)
    } finally {
      await reopened.close()
    }
  })

test('HTTP stop after image storage but before agent publication keeps a readable question', async (t) => {
  const { store, model, agents, user, session } = await fixture(t)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const stopping = Promise.withResolvers<void>()
  const create = agents.ctx.agents.create.bind(agents.ctx.agents)
  t.mock.method(agents.ctx.agents, 'create', async (...args: Parameters<typeof create>) => {
    entered.resolve()
    await release.promise
    return create(...args)
  })
  const stop = agents.stop.bind(agents)
  t.mock.method(agents, 'stop', (...args: Parameters<typeof stop>) => {
    const result = stop(...args)
    stopping.resolve()
    return result
  })
  const server = createApp(store, agents, {
    authenticate: async () => ({ subject: 'image-cancel-test', name: 'Test' }),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${session.id}`
    const starting = fetch(`${url}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'HTTP 取消', images: [gif] }),
    })
    await entered.promise
    assert.ok(store.imageBytes(user.id) > 0)
    const stopped = fetch(`${url}/stop`, { method: 'POST' })
    await stopping.promise
    release.resolve()
    assert.equal((await starting).status, 202)
    assert.equal((await stopped).status, 200)
    const view = await agents.snapshot(user.id, session.id)
    assert.equal(view.running, false)
    assert.equal(view.messages.length, 1)
    const question = view.messages[0]
    assert.ok(question.role === 'user' && question.images?.length === 1)
    const image = await fetch(`${url}/images/${encodeURIComponent(question.images[0].id)}`)
    assert.equal(image.status, 200)
    assert.equal((await image.arrayBuffer()).byteLength, store.imageBytes(user.id))
    assert.equal(model.requests.length, 0)
  } finally {
    release.resolve()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a real image write failure still retains its conservative quota charge', async (t) => {
  const { root, store, model, agents, user, session } = await fixture(t)
  // A regular file blocks creation of the attachment directory, independently of uid privileges.
  writeFileSync(join(root, 'dsh'), 'test-only storage obstruction')
  await assert.rejects(
    agents.start(user.id, session.id, '磁盘失败', undefined, [gif]),
    /EEXIST|ENOTDIR/,
  )
  assert.ok(store.imageBytes(user.id) > 0)
  assert.equal(model.requests.length, 0)
  assert.equal(agents.active.size, 0)
})
