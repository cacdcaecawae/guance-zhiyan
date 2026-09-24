import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Artifact, SessionSummary, User } from '../src/types/index.ts'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** SQLite owns identity and indexes; DSH alone owns message history. */
export class Store {
  db: DatabaseSync
  root: string
  constructor(root: string) {
    this.root = root
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(root, 'app.sqlite'))
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, subject TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(user_id, created);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), name TEXT NOT NULL, format TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id);
    `)
  }
  user(subject: string, name: string): User {
    this.db.prepare('INSERT OR IGNORE INTO users VALUES(?, ?, ?)').run(randomUUID(), subject, name)
    return this.db
      .prepare('SELECT id, name FROM users WHERE subject=?')
      .get(subject) as unknown as User
  }
  list(userId: string): SessionSummary[] {
    return this.db
      .prepare('SELECT id, title FROM sessions WHERE user_id=? ORDER BY created DESC LIMIT 100')
      .all(userId) as unknown as SessionSummary[]
  }
  session(userId: string, id: string): SessionSummary {
    const row = this.db
      .prepare('SELECT id, title FROM sessions WHERE id=? AND user_id=?')
      .get(id, userId)
    if (!row) throw new HttpError(404, '没有找到会话。')
    return row as unknown as SessionSummary
  }
  create(userId: string): SessionSummary {
    const session = { id: randomUUID(), title: '新研究' }
    this.db
      .prepare('INSERT INTO sessions VALUES(?, ?, ?, ?)')
      .run(session.id, userId, session.title, Date.now())
    return session
  }
  title(userId: string, id: string, question: string) {
    this.session(userId, id)
    this.db
      .prepare("UPDATE sessions SET title=? WHERE id=? AND title='新研究'")
      .run(question.slice(0, 80), id)
  }
  artifacts(userId: string, sessionId: string): Artifact[] {
    this.session(userId, sessionId)
    return this.db
      .prepare(
        'SELECT id, session_id AS sessionId, name, format, size FROM artifacts WHERE session_id=?',
      )
      .all(sessionId) as unknown as Artifact[]
  }
  artifact(userId: string, id: string): Artifact {
    const row = this.db
      .prepare(
        `SELECT a.id, a.session_id AS sessionId, a.name, a.format, a.size FROM artifacts a JOIN sessions s ON s.id=a.session_id WHERE a.id=? AND s.user_id=?`,
      )
      .get(id, userId)
    if (!row) throw new HttpError(404, '没有找到文件。')
    return row as unknown as Artifact
  }
  addArtifact(userId: string, artifact: Artifact) {
    this.session(userId, artifact.sessionId)
    this.db
      .prepare('INSERT INTO artifacts VALUES(?, ?, ?, ?, ?)')
      .run(artifact.id, artifact.sessionId, artifact.name, artifact.format, artifact.size)
  }
  close() {
    this.db.close()
  }
}
