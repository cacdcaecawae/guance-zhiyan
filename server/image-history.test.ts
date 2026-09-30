import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
  type DeepSeekAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import { Agents } from './agent.ts'
import { Store } from './store.ts'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const events = [
  { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]
interface WireRequest {
  messages: {
    role: string
    content: { type: string; source?: { type: string }; text?: string }[]
  }[]
}

for (const mode of ['files', 'inline'] as const)
  test(`native image ${mode} budget recovers, persists, and keeps original attachments readable`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'gczy-image-history-test-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'dsh')
    const requests: WireRequest[] = []
    let uploads = 0
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        assert.equal(url.origin, 'https://image-history.invalid', 'never contact a real provider')
        if (url.pathname === '/v1/files') {
          uploads++
          if (mode === 'inline')
            return Response.json({ error: { message: 'Files unavailable' } }, { status: 404 })
          assert.ok(init?.body instanceof FormData)
          const file = init.body.get('file')
          assert.ok(file instanceof Blob)
          return Response.json({
            id: `file-${uploads}`,
            type: 'file',
            mime_type: file.type,
            size_bytes: file.size,
            created_at: new Date().toISOString(),
            filename: 'image.png',
          })
        }
        assert.equal(url.pathname, '/v1/messages')
        assert.equal(typeof init?.body, 'string')
        requests.push(JSON.parse(init!.body as string) as WireRequest)
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      },
    )
    const store = new Store(root)
    let agents!: Agents
    const makeAgents = async () => {
      const adapter = new DeepSeekAdapter({
        options: () =>
          resolveAdapterOptions({
            baseURL: 'https://image-history.invalid',
            models: [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }],
            // Exercise the native budget checks with small limits, without hundreds of turns.
            ...(mode === 'files'
              ? { maxImagesPerRequest: 2, imageOffloadCountQuantum: 1 }
              : { maxInlineRequestImageBytes: 256, inlineImageOffloadByteQuantum: 1 }),
          }),
        resolveApiKey: async () => 'image-history-test-only',
        resolveUserId: () =>
          'image-history-test' as ReturnType<DeepSeekAdapterOptions['resolveUserId']>,
        resolveAttachments: () => agents.ctx.attachments,
        prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
      })
      agents = new Agents(store, { adapter })
      await agents.init()
    }
    await makeAgents()
    try {
      const user = store.user('image-history-test', 'Test')
      const session = store.create(user.id)
      const ask = async (images: Parameters<Agents['start']>[4] = []) => {
        const before = requests.length
        await agents.start(user.id, session.id, '继续分析', undefined, images)
        await agents.active.get(session.id)?.done
        const snapshot = await agents.snapshot(user.id, session.id)
        const answer = snapshot.messages.at(-1)
        assert.ok(answer?.role === 'assistant' && answer.status === 'done')
        assert.equal(
          requests.length,
          before + 1,
          'local budget recovery sends one successful request',
        )
        return snapshot
      }
      const first = await ask([{ mediaType: 'image/png', data: png, name: '原图.png' }])
      const question = first.messages[0]
      assert.ok(question.role === 'user' && question.images?.length === 1)
      const id = question.images[0].id
      const original = await agents.image(user.id, session.id, id)
      const charged = store.imageBytes(user.id)
      await ask([{ id }])
      const recovered = await ask([{ id }])
      const offloads = (await agents.events(session.id)).filter(
        (event) => event.type === 'image/offload',
      )
      assert.ok(offloads.length > 0, 'over-budget images produce a durable recovery decision')
      assert.ok(recovered.trace.some((row) => row.label === '图片上下文调整'))
      assert.equal(recovered.messages.filter((message) => message.role === 'user').length, 3)
      assert.equal(
        store.imageBytes(user.id),
        charged,
        'offload does not reupload or recount originals',
      )
      const retained = requests
        .at(-1)!
        .messages.flatMap((message) => message.content.filter((block) => block.type === 'image'))
      assert.ok(retained.length > 0 && retained.length < 3)
      assert.ok(
        retained.every((block) => block.source?.type === (mode === 'files' ? 'file' : 'base64')),
      )
      assert.deepEqual((await agents.image(user.id, session.id, id)).data, original.data)

      await ask() // The formerly poisoned session accepts text-only follow-ups.
      await agents.close()
      await makeAgents()
      const resumed = await ask()
      assert.ok(resumed.trace.some((row) => row.label === '图片上下文调整'))
      assert.deepEqual((await agents.image(user.id, session.id, id)).data, original.data)
      await ask([{ id }]) // A new occurrence of an old image can be shown to the model again.
      assert.ok(
        requests
          .at(-1)!
          .messages.at(-1)!
          .content.some((block) => block.type === 'image'),
      )
    } finally {
      await agents.close()
      store.close()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      assert.ok(
        resolve(root).startsWith(resolve(tmpdir()) + sep) &&
          root.includes('gczy-image-history-test-'),
      )
      await rm(root, { recursive: true })
    }
  })
