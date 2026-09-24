import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import JSZip from 'jszip'
import { Store } from './store.ts'
import { Agents } from './agent.ts'
import { Artifacts } from './artifacts.ts'
import { Sandboxes, sandboxConfig } from './sandboxes.ts'
import { SessionSandbox, RemoteShell } from './sandbox-tools.ts'
import { TestModel, textChunks, toolChunks } from '../tests/support/model.ts'

// Real OpenSandbox SDK over HTTP/SSE; the fixture never executes supplied shell commands.
async function protocolFixture() {
  const creations: Record<string, unknown>[] = []
  const live = new Map<string, { volume: string; pending: ServerResponse[] }>()
  const volumes = new Map<string, Map<string, string>>()
  const uploads = new Map<string, string>()
  const commandStarted = new Set<() => void>()
  const errors: unknown[] = []
  const state: { failDeletes: number; officeWritten?: () => void } = { failDeletes: 0 }
  let origin = ''
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    try {
      assert.equal(request.headers['open-sandbox-api-key'], 'fixture-only')
      const url = new URL(request.url!, origin)
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      if (url.pathname === '/v1/sandboxes' && request.method === 'POST') {
        const data = JSON.parse(body.toString())
        creations.push(data)
        assert.deepEqual(data.resourceLimits, { cpu: '1', memory: '1Gi' })
        assert.equal(data.volumes[0].pvc.deleteOnSandboxTermination, false)
        assert.ok(
          data.networkPolicy.egress.some(
            (rule: { target: string }) => rule.target === '169.254.0.0/16',
          ),
        )
        assert.deepEqual(data.env, {})
        const id = `sandbox-${creations.length}`
        const volume = data.volumes[0].pvc.claimName
        live.set(id, { volume, pending: [] })
        if (!volumes.has(volume)) volumes.set(volume, new Map())
        return json({ id, createdAt: new Date().toISOString(), status: { state: 'Running' } }, 202)
      }
      const match = /^\/v1\/sandboxes\/([^/]+)(.*)$/.exec(url.pathname)
      if (match) {
        const [, id, tail] = match
        const entry = live.get(id)
        if (!entry) return json({ code: 'NOT_FOUND', message: 'not found' }, 404)
        if (!tail && request.method === 'GET')
          return json({ id, createdAt: new Date().toISOString(), status: { state: 'Running' } })
        if (!tail && request.method === 'DELETE') {
          if (state.failDeletes > 0) {
            state.failDeletes--
            return json({ code: 'TEMPORARY', message: 'retry' }, 500)
          }
          for (const stream of entry.pending) stream.destroy()
          live.delete(id)
          response.writeHead(204)
          return response.end()
        }
        if (tail.startsWith('/endpoints/'))
          return json({ endpoint: origin.replace('http://', '') + `/exec/${id}` })
        if (tail === '/renew-expiration')
          return json({ expiresAt: new Date(Date.now() + 600000).toISOString() })
      }
      const endpoint = /^\/exec\/([^/]+)(.*)$/.exec(url.pathname)
      if (endpoint) {
        const [, id, path] = endpoint
        const entry = live.get(id)!
        const files = volumes.get(entry.volume)!
        if (path === '/ping') return json({ ok: true })
        if (path === '/files/upload') {
          const form = await new Response(body, {
            headers: { 'content-type': request.headers['content-type']! },
          }).formData()
          const meta = JSON.parse(await (form.get('metadata') as Blob).text())
          assert.equal(meta.mode, 600)
          assert.equal(meta.owner, 'node')
          assert.equal(meta.group, 'node')
          uploads.set(meta.path, await (form.get('file') as Blob).text())
          response.writeHead(204)
          return response.end()
        }
        if (path === '/files' && request.method === 'DELETE') {
          response.writeHead(204)
          return response.end()
        }
        if (path === '/command') {
          const data = JSON.parse(body.toString())
          assert.equal(data.uid, 1000)
          assert.equal(data.gid, 1000)
          assert.equal(data.envs, undefined)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          const event = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`)
          event({ type: 'init', text: 'command' })
          if (data.argv[0] === 'bash') {
            assert.equal(data.cwd, '/workspace')
            if (data.argv[2] === 'wait-for-stop') {
              event({ type: 'stdout', text: 'working' })
              entry.pending.push(response)
              for (const ready of commandStarted) ready()
              return
            }
            if (data.argv[2] === 'large-output') {
              event({ type: 'stdout', text: 'x'.repeat(200000) })
              event({ type: 'stdout', text: 'TAIL-MARKER' })
              event({ type: 'execution_complete' })
              return response.end()
            }
            assert.equal(data.argv[2], 'printf sandbox')
            files.set('/workspace/report.txt', 'sandbox report')
            event({ type: 'stdout', text: 'sandbox' })
          } else if (data.argv[0] === 'python3') {
            assert.ok(
              files.has(data.argv[3]),
              'Office temp file survives competing sandbox admission',
            )
            event({ type: 'stdout', text: 'fixture office' })
          } else {
            assert.deepEqual(data.argv.slice(0, 2), ['node', '/opt/gczy/fs-worker.mjs'])
            const { method, args } = JSON.parse(uploads.get(data.argv[2])!)
            let value: unknown
            if (method === 'resolve')
              value = {
                targetKey: args[0].startsWith('/') ? args[0] : `/workspace/${args[0]}`,
                displayPath: args[0].startsWith('/') ? args[0] : `/workspace/${args[0]}`,
              }
            else if (method === 'readBytes')
              value = Buffer.from(files.get(args[0].displayPath) ?? '').toString('base64')
            else if (method === 'writeBytes') {
              files.set(args[0], Buffer.from(args[1], 'base64').toString())
              if (args[0].startsWith('/tmp/gczy-office-')) state.officeWritten?.()
            } else if (method === 'stat')
              value = files.has(args[0].displayPath)
                ? { type: 'file', size: files.get(args[0].displayPath)!.length, version: '1' }
                : undefined
            else if (method === 'readText') value = files.get(args[0].displayPath)
            else throw new Error(`Unexpected RPC ${method}`)
            event({ type: 'stdout', text: JSON.stringify({ value }) })
          }
          event({ type: 'execution_complete' })
          return response.end()
        }
      }
      throw new Error(`Unexpected ${request.method} ${url.pathname}`)
    } catch (e) {
      errors.push(e)
      if (!response.headersSent) json({ error: 'fixture failure' }, 500)
      else response.destroy()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { server, origin, live, creations, volumes, errors, commandStarted, state }
}

test('DSH tools use isolated OpenSandbox SDK sessions, persist exports and kill remote execution on stop', async () => {
  const fixture = await protocolFixture()
  const root = await mkdtemp(join(tmpdir(), 'gczy-sandbox-'))
  const store = new Store(root)
  const manager = await new Sandboxes(store, {
    endpoint: fixture.origin,
    apiKey: 'fixture-only',
    image: 'fixture-image',
    capacity: 2,
    cpu: '1',
    memory: '1Gi',
    idleSeconds: 300,
  }).init()
  const model = new TestModel(() => textChunks('你好'))
  const agents = await new Agents(store, { adapter: model, sandboxes: manager }).init()
  try {
    const alice = store.user('fixture:alice', 'Alice'),
      bob = store.user('fixture:bob', 'Bob')
    const a = store.create(alice.id),
      b = store.create(bob.id)
    await agents.start(alice.id, a.id, 'hello')
    await agents.active.get(a.id)?.done
    assert.equal(fixture.creations.length, 0, 'ordinary chat is lazy')
    assert.ok(model.requests[0].tools?.some((tool) => tool.name === 'bash'))
    assert.ok(model.requests[0].tools?.some((tool) => tool.name === 'read'))
    let step = 0
    model.respond = () =>
      ++step === 1
        ? toolChunks('bash', { command: 'printf sandbox', description: 'test command' })
        : step === 2
          ? toolChunks('export_file', { path: '/workspace/report.txt' })
          : textChunks('已生成')
    await agents.start(alice.id, a.id, 'run')
    await agents.active.get(a.id)?.done
    const view = await agents.snapshot(alice.id, a.id)
    const toolRows = view.trace.filter((row) => row.kind === 'tool')
    assert.deepEqual(
      toolRows.map((row) => row.status),
      ['done', 'done'],
      JSON.stringify(toolRows),
    )
    assert.equal(view.artifacts[0].format, 'txt')
    assert.equal(await readFile(agents.files.path(view.artifacts[0].id), 'utf8'), 'sandbox report')
    assert.throws(() => store.artifact(bob.id, view.artifacts[0].id), /没有找到/)
    await assert.rejects(
      manager.use(bob.id, a.id, undefined, async () => {}),
      /没有找到/,
    )
    const second = new SessionSandbox(manager, bob.id, b.id)
    await second.writeFile('own.txt', Buffer.from('bob'))
    assert.equal(fixture.creations.length, 2)
    assert.notEqual(fixture.creations[0].volumes, fixture.creations[1].volumes)
    const session = new SessionSandbox(manager, alice.id, a.id)
    const zip = new JSZip()
    zip.file('word/document.xml', 'x'.repeat(8 * 1024 * 1024))
    const compressed = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    assert.ok(compressed.length < 50000)
    const external = await new Artifacts(store).save(alice.id, a.id, 'compressed.docx', compressed)
    await assert.rejects(agents.files.read(alice.id, a.id, external.id), /需要在会话沙箱中读取/)
    const ctx = new Context()
    const shell = new RemoteShell(ctx, session)
    const process = await shell.execute(
      shell.resolve({ command: 'large-output', stdoutMaxBytes: 1024 }),
    )
    const output = await process.result()
    assert.equal(output.stdout.truncated, true)
    assert.ok(output.stdout.text.endsWith('\nTAIL-MARKER\n'))
    const observed = process.observed.stdout.readFrom(1024)
    assert.equal(observed.nextOffset, 200013)
    assert.equal(observed.lossy, true)
    assert.ok(observed.text.endsWith('\nTAIL-MARKER\n'))
    assert.equal(process.observed.stdout.readFrom(observed.nextOffset).text, '')
    await ctx.fiber.dispose()
    await assert.rejects(session.exportFile('/etc/passwd', agents.files), /只能导出/)
    fixture.state.failDeletes = 1
    await assert.rejects(manager.stop(alice.id, a.id), /沙箱服务不可用/)
    await manager.stop(alice.id, a.id)
    assert.equal(fixture.live.size, 1)
    const exported = await session.exportFile('/workspace/report.txt', agents.files)
    assert.equal(await agents.files.read(alice.id, a.id, exported.id), 'sandbox report')
    assert.equal(fixture.creations.length, 3, 'new container remounts the persisted workspace')
    const started = Promise.withResolvers<void>()
    fixture.commandStarted.add(started.resolve)
    model.respond = () => toolChunks('bash', { command: 'wait-for-stop', description: 'wait' })
    await agents.start(alice.id, a.id, 'long task')
    await started.promise
    await agents.stop(alice.id, a.id)
    assert.equal((await agents.snapshot(alice.id, a.id)).messages.at(-1)?.role, 'assistant')
    const stopped = (await agents.snapshot(alice.id, a.id)).messages.at(-1)!
    assert.ok(stopped.role === 'assistant' && stopped.status === 'stopped')
    assert.equal(fixture.live.size, 1, 'stopping Alice preserves Bob')
    assert.equal(await readFile(agents.files.path(exported.id), 'utf8'), 'sandbox report')
    assert.deepEqual(fixture.errors, [])
  } finally {
    await agents.close()
    store.close()
    fixture.server.closeAllConnections()
    fixture.server.close()
    await once(fixture.server, 'close')
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-sandbox-'))
    await rm(root, { recursive: true })
  }
})

test('sandbox capacity waits, queued cancellation creates nothing, idle eviction and restart preserve volumes', async () => {
  const fixture = await protocolFixture()
  const root = await mkdtemp(join(tmpdir(), 'gczy-capacity-'))
  const store = new Store(root)
  const config = {
    endpoint: fixture.origin,
    apiKey: 'fixture-only',
    image: 'fixture-image',
    capacity: 1,
    cpu: '1',
    memory: '1Gi',
    idleSeconds: 300,
  }
  let manager = await new Sandboxes(store, config).init()
  try {
    const user = store.user('capacity:user', 'Test')
    const a = store.create(user.id),
      b = store.create(user.id)
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const holding = manager.use(user.id, a.id, undefined, async () => {
      started.resolve()
      await release.promise
    })
    await started.promise
    const abort = new AbortController()
    const queued = manager.use(user.id, b.id, abort.signal, async () => {})
    const rejected = assert.rejects(queued)
    abort.abort()
    await rejected
    assert.equal(fixture.creations.length, 1)
    release.resolve()
    await holding
    const session = new SessionSandbox(manager, user.id, b.id)
    await session.writeFile('kept.txt', Buffer.from('persistent'))
    assert.equal(fixture.live.size, 1)
    assert.equal(fixture.creations.length, 2)
    // Simulate process loss: relinquish SDK transport without deleting the remote container.
    clearInterval(manager.timer)
    for (const entry of manager.entries.values()) await (await entry.remote).close()
    manager = await new Sandboxes(store, config).init()
    assert.equal(fixture.live.size, 0, 'restart retires the old instance before remounting')
    const current = new SessionSandbox(manager, user.id, b.id)
    const target = await current.rpc<{ targetKey: string; displayPath: string }>('resolve', [
      '/workspace/kept.txt',
    ])
    assert.equal(await current.rpc('readText', [target]), 'persistent')
    let competing: Promise<void> | undefined
    fixture.state.officeWritten = () => {
      competing = manager.use(user.id, a.id, undefined, async () => {})
    }
    assert.equal(
      await current.readOffice(Buffer.from('fixture office'), 'docx'),
      'fixture office\n',
    )
    await competing
    assert.deepEqual(fixture.errors, [])
  } finally {
    await manager.close()
    store.close()
    fixture.server.closeAllConnections()
    fixture.server.close()
    await once(fixture.server, 'close')
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-capacity-'))
    await rm(root, { recursive: true })
  }
})

test('sandbox filesystem worker reuses native atomic edits, version guards and bounded binary reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-worker-'))
  const request = join(root, 'request.json')
  const file = join(root, 'report.txt')
  const worker = resolve('server/sandbox/fs-worker.mjs')
  const call = async (method: string, args: unknown[]) => {
    await writeFile(request, JSON.stringify({ method, args }))
    const { stdout } = await promisify(execFile)(process.execPath, [worker, request], {
      cwd: root,
      windowsHide: true,
    })
    return JSON.parse(stdout)
  }
  try {
    const target = (await call('resolve', [file])).value
    const first = (await call('writeText', [target, 'hello\nworld'])).value
    assert.equal(first.operation, 'create')
    const updated = await call('editText', [
      target,
      { oldString: 'world', newString: 'sandbox', replaceAll: false },
      { version: first.version },
    ])
    assert.equal(updated.value.after, 'hello\nsandbox')
    assert.equal(
      (
        await call('writeText', [
          target,
          'overwrite',
          { kind: 'replaceIfVersion', version: first.version },
        ])
      ).error.code,
      'FS_STALE_VERSION',
    )
    assert.equal((await call('readBytes', [target, null, 2])).error.code, 'FS_TOO_LARGE')
    assert.equal(await readFile(file, 'utf8'), 'hello\nsandbox')
    assert.equal(
      (await call('writeText', [target, 'new', { kind: 'createIfAbsent' }])).error.code,
      'FS_NOT_OBSERVED',
    )
    assert.equal(sandboxConfig({}), undefined)
    assert.throws(() => sandboxConfig({ SANDBOX_URL: 'http://127.0.0.1:8080' }), /配置无效/)
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-worker-'))
    await rm(root, { recursive: true })
  }
})
