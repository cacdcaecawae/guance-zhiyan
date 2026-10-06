import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs, { type FileHandle } from 'node:fs/promises'
import { get } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ReadStream } from 'node:fs'
import type { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { Store } from './store.ts'

async function fixture(t: TestContext, size = 8 * 2 ** 20) {
  const root = await fs.mkdtemp(join(tmpdir(), 'gczy-download-'))
  const store = new Store(root)
  const user = store.user('download-owner', 'Test')
  const session = store.create(user.id)
  const artifact = {
    id: randomUUID(),
    sessionId: session.id,
    name: "O'Reilly 研究(2026).bin",
    format: 'bin',
    size,
  }
  const path = join(root, artifact.id)
  await fs.writeFile(path, Buffer.alloc(size, 97))
  store.addArtifact(user.id, artifact)
  const agents = { files: { path: () => path } } as unknown as Agents
  const server = createApp(store, agents, {
    authenticate: async (request) => ({
      subject: request.headers['x-test-user'] === 'other' ? 'download-other' : 'download-owner',
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
    store.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  return {
    store,
    user,
    session,
    artifact,
    path,
    server,
    url: `http://127.0.0.1:${address.port}/api/files/${artifact.id}`,
  }
}

test('artifact downloads preserve bytes, headers and ownership when streamed', async (t) => {
  const f = await fixture(t)
  const denied = await fetch(f.url, { headers: { 'x-test-user': 'other' } })
  assert.equal(denied.status, 404)
  await denied.arrayBuffer()
  const response = await fetch(f.url)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-length'), String(f.artifact.size))
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.match(response.headers.get('content-disposition')!, /O%27Reilly%20.*%282026%29\.bin/)
  const data = Buffer.from(await response.arrayBuffer())
  assert.equal(data.length, f.artifact.size)
  assert.ok(data.every((byte) => byte === 97))
  await fs.unlink(f.path)
  const missing = await fetch(f.url)
  assert.equal(missing.status, 500, 'a missing stored file must not start a successful download')
  await missing.arrayBuffer()
  await fs.mkdir(f.path)
  const directory = await fetch(f.url)
  assert.equal(directory.status, 500, 'a non-file path must fail before download headers')
  await directory.arrayBuffer()
})

test('a client that disconnects during file admission does not trigger a full read or leak a handle', async (t) => {
  const f = await fixture(t)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  let buffered = 0
  let streams = 0
  let opened: FileHandle | undefined
  const readFile = fs.readFile
  const open = fs.open
  // Hold the actual I/O admission boundary; cover both the former buffered path and the stream.
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof readFile>) => {
    if (args[0] === f.path) {
      entered.resolve()
      await release.promise
    }
    const data = await readFile(...args)
    if (args[0] === f.path) {
      buffered += Buffer.byteLength(data)
      finished.resolve()
    }
    return data
  })
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    if (args[0] === f.path) {
      entered.resolve()
      await release.promise
    }
    const handle = await open(...args)
    if (args[0] === f.path) {
      opened = handle
      const create = handle.createReadStream.bind(handle)
      t.mock.method(handle, 'createReadStream', (...options: Parameters<typeof create>) => {
        streams++
        return create(...options)
      })
      const close = handle.close.bind(handle)
      t.mock.method(handle, 'close', async () => {
        await close()
        finished.resolve()
      })
    }
    return handle
  })
  syncBuiltinESMExports()
  f.server.on('request', (_request, response) => response.once('close', () => closed.resolve()))
  try {
    const request = get(f.url)
    request.on('error', () => {})
    await entered.promise
    request.destroy()
    await closed.promise
    release.resolve()
    await finished.promise
    assert.equal(buffered, 0)
    assert.equal(streams, 0)
    assert.equal(opened?.fd, -1, 'the admitted file handle is closed even with no response')
  } finally {
    release.resolve()
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('disconnecting mid-download destroys the file reader and closes its handle', async (t) => {
  const f = await fixture(t)
  const paused = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  let reader: ReadStream | undefined
  let opened: FileHandle | undefined
  const open = fs.open
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    if (args[0] === f.path) {
      opened = handle
      const create = handle.createReadStream.bind(handle)
      t.mock.method(handle, 'createReadStream', (...options: Parameters<typeof create>) => {
        reader = create(...options)
        const read = reader._read.bind(reader)
        let first = true
        // Deliver one real file chunk, then hold the next read until the client disconnects.
        t.mock.method(reader, '_read', (size: number) => {
          if (first) {
            first = false
            read(size)
          } else paused.resolve()
        })
        return reader
      })
      const close = handle.close.bind(handle)
      t.mock.method(handle, 'close', async () => {
        await close()
        finished.resolve()
      })
    }
    return handle
  })
  syncBuiltinESMExports()
  const request = get(f.url)
  request.on('error', () => {})
  try {
    const [response] = await once(request, 'response')
    assert.equal(response.statusCode, 200)
    assert.ok(reader, 'the response streams from an open file')
    await paused.promise
    request.destroy()
    await finished.promise
    assert.equal(reader.destroyed, true)
    assert.ok(reader.bytesRead > 0 && reader.bytesRead < f.artifact.size)
    assert.equal(opened?.fd, -1)
  } finally {
    request.destroy()
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})
