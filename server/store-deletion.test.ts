import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Store } from './store.ts'

test('deletion migration preserves legacy sessions and defaults them to visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guance-store-delete-'))
  const db = new DatabaseSync(join(root, 'app.sqlite'))
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, subject TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, created INTEGER NOT NULL);
    INSERT INTO users VALUES('owner', 'legacy-owner', 'Test');
    INSERT INTO sessions VALUES('legacy-session', 'owner', 'Old research', 1);
  `)
  db.close()
  const store = new Store(root)
  try {
    assert.equal(store.session('owner', 'legacy-session').title, 'Old research')
    assert.equal(store.list('owner').length, 1)
    assert.deepEqual(store.pendingRemovals(), [])
    assert.equal(store.db.prepare('SELECT deleted FROM sessions').get()!.deleted, 0)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('pending deletion preserves ownership, image quota and live sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guance-store-delete-'))
  const store = new Store(root)
  try {
    const alice = store.user('alice', 'Alice')
    const bob = store.user('bob', 'Bob')
    const deleted = store.create(alice.id)
    const live = store.create(alice.id)
    const file = {
      id: '00000000-0000-4000-a000-000000000001',
      sessionId: deleted.id,
      name: 'synthetic.txt',
      format: 'txt',
      size: 7,
    }
    store.addArtifact(alice.id, file)
    store.addImages(alice.id, [{ attachmentId: 'synthetic-shared', bytes: 12 }], 100)
    assert.throws(() => store.remove(bob.id, deleted.id), { status: 404 })
    assert.deepEqual(store.remove(alice.id, deleted.id), [file.id])
    const listed = store.list(alice.id).map((row) => row.id)
    assert.deepEqual(listed, [live.id])
    for (const user of [alice.id, bob.id]) {
      assert.throws(() => store.session(user, deleted.id), { status: 404 })
      assert.throws(() => store.artifact(user, file.id), { status: 404 })
      assert.throws(() => store.artifacts(user, deleted.id), { status: 404 })
      assert.throws(() => store.update(user, deleted.id, { title: 'restore' }), { status: 404 })
      assert.throws(() => store.generatedArtifact(user, file.id), { status: 404 })
      assert.throws(() => store.addArtifact(user, { ...file, id: 'new' }), { status: 404 })
    }
    assert.deepEqual(store.pendingRemovals(), [{ id: deleted.id, files: [file.id] }])
    store.finishRemoval(live.id)
    assert.equal(store.session(alice.id, live.id).id, live.id)
    store.finishRemoval(deleted.id)
    store.finishRemoval(deleted.id)
    assert.deepEqual(store.pendingRemovals(), [])
    assert.equal(store.imageBytes(alice.id), 12)
    assert.equal(store.imageBytes(bob.id), 0)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('mark and finalization failures roll back without losing cleanup indexes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guance-store-delete-'))
  const store = new Store(root)
  try {
    const user = store.user('rollback', 'Test')
    const session = store.create(user.id)
    store.addArtifact(user.id, {
      id: '00000000-0000-4000-a000-000000000002',
      sessionId: session.id,
      name: 'synthetic.txt',
      format: 'txt',
      size: 3,
    })
    store.db.exec(`CREATE TRIGGER deny_mark BEFORE UPDATE OF deleted ON sessions
      BEGIN SELECT RAISE(ABORT, 'synthetic mark failure'); END;`)
    assert.throws(() => store.remove(user.id, session.id), /synthetic mark failure/)
    assert.equal(store.session(user.id, session.id).id, session.id)
    assert.equal(store.artifacts(user.id, session.id).length, 1)
    assert.deepEqual(store.pendingRemovals(), [])
    store.db.exec('DROP TRIGGER deny_mark')
    store.remove(user.id, session.id)
    store.db.exec(`CREATE TRIGGER deny_finalize BEFORE DELETE ON sessions
      BEGIN SELECT RAISE(ABORT, 'synthetic finalize failure'); END;`)
    assert.throws(() => store.finishRemoval(session.id), /synthetic finalize failure/)
    assert.equal(store.pendingRemovals()[0].files.length, 1)
    assert.equal(store.db.prepare('SELECT SUM(size) AS n FROM artifacts').get()!.n, 3)
    store.db.exec('DROP TRIGGER deny_finalize')
    store.finishRemoval(session.id)
    assert.deepEqual(store.pendingRemovals(), [])
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('sandbox recovery records block the durable deletion marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guance-store-delete-'))
  const store = new Store(root)
  try {
    const user = store.user('sandbox-recovery', 'Test')
    const session = store.create(user.id)
    store.db.prepare('INSERT INTO sandboxes VALUES(?, ?)').run(session.id, 'synthetic-remote')
    assert.throws(() => store.remove(user.id, session.id), { status: 503 })
    assert.equal(store.session(user.id, session.id).id, session.id)
    assert.deepEqual(store.pendingRemovals(), [])
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sandboxes').get()!.n, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})
