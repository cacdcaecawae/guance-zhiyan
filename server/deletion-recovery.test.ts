import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Store } from './store.ts'
import { Agents } from './agent.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'guance-delete-recovery-'))
  let store = new Store(root)
  let agents = await new Agents(store).init()
  const user = store.user('synthetic-cleanup-owner', 'Test')
  const session = store.create(user.id)
  t.after(async () => {
    await agents.close()
    store.close()
    assert.ok(root.startsWith(join(tmpdir(), 'guance-delete-recovery-')))
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    user,
    session,
    get store() {
      return store
    },
    get agents() {
      return agents
    },
    async reopen() {
      await agents.close()
      store.close()
      store = new Store(root)
      agents = await new Agents(store).init()
    },
  }
}

// A nonempty directory at a file path makes the actual nonrecursive fs.rm fail on all
// supported test users, including root. Its child retains the original synthetic bytes.
async function obstructArtifact(path: string) {
  await rename(path, path + '.held')
  await mkdir(path)
  await rename(path + '.held', join(path, 'retained.bin'))
  return async () => {
    await rename(join(path, 'retained.bin'), path + '.held')
    await rmdir(path)
    await rename(path + '.held', path)
  }
}

test('failed artifact cleanup keeps durable cleanup identity and blocks every normal read', async (t) => {
  const f = await fixture(t)
  const file = await f.agents.files.save(
    f.user.id,
    f.session.id,
    'synthetic.txt',
    Buffer.from('kept'),
  )
  await obstructArtifact(f.agents.files.path(file.id))
  await assert.rejects(f.agents.remove(f.user.id, f.session.id), { status: 500 })
  assert.deepEqual(f.store.list(f.user.id), [])
  assert.throws(() => f.store.session(f.user.id, f.session.id), { status: 404 })
  assert.throws(() => f.store.artifact(f.user.id, file.id), { status: 404 })
  await assert.rejects(f.agents.snapshot(f.user.id, f.session.id), { status: 404 })
  await assert.rejects(f.agents.image(f.user.id, f.session.id, 'synthetic'), { status: 404 })
  await assert.rejects(f.agents.start(f.user.id, f.session.id, 'no resurrection'), { status: 404 })
  const pending = f.store.db.prepare('SELECT * FROM sessions WHERE id=?').get(f.session.id)
  assert.equal(pending?.deleted, 1, 'cleanup intent must survive the failed filesystem deletion')
  assert.equal(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE session_id=?').get(f.session.id)!.n,
    1,
  )
})

test('restart replays a previously failed artifact deletion after its obstruction is repaired', async (t) => {
  const f = await fixture(t)
  const file = await f.agents.files.save(
    f.user.id,
    f.session.id,
    'synthetic.txt',
    Buffer.from('kept'),
  )
  const path = f.agents.files.path(file.id)
  const repair = await obstructArtifact(path)
  await assert.rejects(f.agents.remove(f.user.id, f.session.id), { status: 500 })
  await repair()
  assert.equal(await readFile(path, 'utf8'), 'kept')
  await f.reopen()
  await assert.rejects(stat(path), { code: 'ENOENT' })
  assert.equal(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id=?').get(f.session.id)!.n,
    0,
  )
  assert.equal(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE session_id=?').get(f.session.id)!.n,
    0,
  )
  await f.reopen()
  assert.deepEqual(f.store.list(f.user.id), [], 'a second restart is idempotent')
})

test('failed physical cleanup retains the artifact quota until a successful replay', async (t) => {
  const f = await fixture(t)
  const file = await f.agents.files.save(
    f.user.id,
    f.session.id,
    'synthetic.bin',
    Buffer.alloc(50 * 1024 * 1024),
  )
  const repair = await obstructArtifact(f.agents.files.path(file.id))
  await assert.rejects(f.agents.remove(f.user.id, f.session.id), { status: 500 })
  const other = f.store.create(f.user.id)
  await assert.rejects(
    f.agents.files.save(f.user.id, other.id, 'more.txt', Buffer.from('x')),
    { code: 'FILE_QUOTA' },
  )
  await repair()
  await f.reopen()
  const next = await f.agents.files.save(f.user.id, other.id, 'more.txt', Buffer.from('x'))
  assert.equal(next.size, 1)
})

test('restart replays failed history cleanup without touching a surviving session', async (t) => {
  const f = await fixture(t)
  const other = f.store.create(f.user.id)
  const history = join(f.root, 'sessions')
  const target = join(history, 'synthetic-project', f.session.id, 'session.jsonl')
  const kept = join(history, 'synthetic-project', other.id, 'session.jsonl')
  await mkdir(join(target, '..'), { recursive: true })
  await mkdir(join(kept, '..'), { recursive: true })
  await writeFile(target, 'synthetic deleted history')
  await writeFile(kept, 'synthetic kept history')
  await rename(history, history + '.held')
  await writeFile(history, 'synthetic obstruction')
  await assert.rejects(f.agents.remove(f.user.id, f.session.id), { status: 500 })
  await rm(history)
  await rename(history + '.held', history)
  await f.reopen()
  await assert.rejects(stat(target), { code: 'ENOENT' })
  assert.equal(await readFile(kept, 'utf8'), 'synthetic kept history')
  assert.equal(f.store.session(f.user.id, other.id).id, other.id)
})

test('restart handles loss immediately after the durable marker, before any physical cleanup', async (t) => {
  const f = await fixture(t)
  const file = await f.agents.files.save(
    f.user.id,
    f.session.id,
    'synthetic.txt',
    Buffer.from('kept'),
  )
  const path = f.agents.files.path(file.id)
  const image = join(f.root, 'dsh', 'attachments', 'synthetic-shared-image')
  await mkdir(join(image, '..'), { recursive: true })
  await writeFile(image, 'retained image')
  f.store.addImages(f.user.id, [{ attachmentId: 'synthetic-shared-image', bytes: 14 }], 100)
  // Stop at the actual database boundary. No Agents.remove cleanup has run yet.
  f.store.remove(f.user.id, f.session.id)
  assert.equal(await readFile(path, 'utf8'), 'kept')
  await f.reopen()
  await assert.rejects(stat(path), { code: 'ENOENT' })
  assert.deepEqual(f.store.pendingRemovals(), [])
  assert.equal(await readFile(image, 'utf8'), 'retained image')
  assert.equal(f.store.imageBytes(f.user.id), 14)
})

test('startup isolates a persistent cleanup failure and completes other pending deletions', async (t) => {
  const f = await fixture(t)
  const other = f.store.create(f.user.id)
  const blocked = await f.agents.files.save(
    f.user.id,
    f.session.id,
    'blocked.txt',
    Buffer.from('bad'),
  )
  const ready = await f.agents.files.save(f.user.id, other.id, 'ready.txt', Buffer.from('good'))
  const repair = await obstructArtifact(f.agents.files.path(blocked.id))
  f.store.remove(f.user.id, f.session.id)
  f.store.remove(f.user.id, other.id)
  await f.reopen()
  await assert.rejects(stat(f.agents.files.path(ready.id)), { code: 'ENOENT' })
  assert.deepEqual(f.store.pendingRemovals(), [{ id: f.session.id, files: [blocked.id] }])
  await f.reopen()
  assert.equal(f.store.pendingRemovals().length, 1)
  await repair()
  await f.reopen()
  assert.deepEqual(f.store.pendingRemovals(), [])
})

test('restart retries final database cleanup after files were already removed', async (t) => {
  const f = await fixture(t)
  const file = await f.agents.files.save(
    f.user.id,
    f.session.id,
    'synthetic.txt',
    Buffer.from('done'),
  )
  const path = f.agents.files.path(file.id)
  f.store.db.exec(`CREATE TRIGGER deny_finalize BEFORE DELETE ON sessions
    BEGIN SELECT RAISE(ABORT, 'synthetic finalize failure'); END;`)
  await assert.rejects(f.agents.remove(f.user.id, f.session.id), { status: 500 })
  await assert.rejects(stat(path), { code: 'ENOENT' })
  assert.deepEqual(f.store.pendingRemovals(), [{ id: f.session.id, files: [file.id] }])
  await f.reopen()
  assert.equal(f.store.pendingRemovals().length, 1)
  f.store.db.exec('DROP TRIGGER deny_finalize')
  await f.reopen()
  assert.deepEqual(f.store.pendingRemovals(), [])
})

test('failed sandbox disposal does not mark the session deleted or remove its files', async (t) => {
  const f = await fixture(t)
  const file = await f.agents.files.save(
    f.user.id,
    f.session.id,
    'synthetic.txt',
    Buffer.from('kept'),
  )
  let calls = 0
  f.agents.options.sandboxes = {
    async discard() {
      calls++
      throw new Error('synthetic sandbox failure')
    },
    async close() {},
  } as never
  await assert.rejects(f.agents.remove(f.user.id, f.session.id), { status: 503 })
  assert.equal(calls, 1)
  assert.equal(f.store.session(f.user.id, f.session.id).id, f.session.id)
  assert.equal(await readFile(f.agents.files.path(file.id), 'utf8'), 'kept')
  assert.deepEqual(f.store.pendingRemovals(), [])
})
