import { createHash } from 'node:crypto'
import { Store, HttpError } from './store.ts'
import { chunkText } from './rag-chunks.ts'

export interface DocumentInput {
  id: string
  title: string
  text: string
  sourceUrl?: string
  publishedAt?: string
}
export interface Passage {
  id: string
  versionId: string
  documentId: string
  title: string
  sourceUrl: string | null
  publishedAt: string | null
  ordinal: number
  start: number
  end: number
  heading: string
  text: string
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
export function terms(text: string) {
  return [...segmenter.segment(text)].filter((part) => part.isWordLike).map((part) => part.segment)
}
function uuid(text: string) {
  const hex = createHash('sha256').update(text).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function documentInput(value: unknown): DocumentInput {
  if (!value || typeof value !== 'object') throw new HttpError(400, '文献必须是 JSON 对象。')
  const input = value as Record<string, unknown>
  for (const [key, max] of [
    ['id', 256],
    ['title', 1000],
    ['text', 5_000_000],
  ] as const) {
    const text = input[key]
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > max ||
      !text.isWellFormed() ||
      text.includes('\0')
    )
      throw new HttpError(400, `文献 ${key} 须为非空有效文本，最长 ${max} 个字符。`)
  }
  if (input.sourceUrl !== undefined) {
    try {
      if (typeof input.sourceUrl !== 'string' || input.sourceUrl.length > 2048) throw new Error()
      const url = new URL(input.sourceUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error()
    } catch {
      throw new HttpError(400, '文献 sourceUrl 须为不含凭据的 HTTP(S) 来源链接。')
    }
  }
  if (
    input.publishedAt !== undefined &&
    (typeof input.publishedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.publishedAt) ||
      !Number.isFinite(Date.parse(input.publishedAt)) ||
      new Date(input.publishedAt).toISOString().slice(0, 10) !== input.publishedAt)
  )
    throw new HttpError(400, '文献 publishedAt 须为有效的 YYYY-MM-DD 日期。')
  return {
    id: input.id as string,
    title: input.title as string,
    text: input.text as string,
    ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl as string }),
    ...(input.publishedAt === undefined ? {} : { publishedAt: input.publishedAt as string }),
  }
}

const passageColumns = `c.id, c.version_id AS versionId, v.document_id AS documentId,
  v.title, v.source_url AS sourceUrl, v.published_at AS publishedAt,
  c.ordinal, c.start, c.end, c.heading, c.text`

/** Immutable source versions keep old citations readable after a document is updated. */
export class LibraryStore {
  store: Store
  constructor(store: Store) {
    this.store = store
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_versions(
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, title TEXT NOT NULL,
        text TEXT NOT NULL, source_url TEXT, published_at TEXT, created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rag_versions_document ON rag_versions(document_id);
      CREATE TABLE IF NOT EXISTS rag_documents(
        id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES rag_versions(id)
      );
      CREATE TABLE IF NOT EXISTS rag_published_versions(id TEXT PRIMARY KEY REFERENCES rag_versions(id));
      CREATE TABLE IF NOT EXISTS rag_chunks(
        id TEXT UNIQUE NOT NULL, version_id TEXT NOT NULL REFERENCES rag_versions(id),
        ordinal INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
        heading TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(version_id, ordinal)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(title, body, tokenize='unicode61');
    `)
  }
  current(documentId: string): string | null {
    return (
      (this.store.db.prepare('SELECT version_id FROM rag_documents WHERE id=?').get(documentId)
        ?.version_id as string | undefined) ?? null
    )
  }
  stage(input: DocumentInput) {
    input = documentInput(input)
    const versionId = uuid(
      JSON.stringify([
        'chunks-v1',
        input.id,
        input.title,
        input.text,
        input.sourceUrl ?? null,
        input.publishedAt ?? null,
      ]),
    )
    if (this.store.db.prepare('SELECT 1 FROM rag_versions WHERE id=?').get(versionId))
      return { versionId, chunks: this.chunks(versionId) }
    const chunks = chunkText(input.text)
    const db = this.store.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO rag_versions VALUES(?, ?, ?, ?, ?, ?, ?)').run(
        versionId,
        input.id,
        input.title,
        input.text,
        input.sourceUrl ?? null,
        input.publishedAt ?? null,
        Date.now(),
      )
      const insert = db.prepare(
        'INSERT INTO rag_chunks(id, version_id, ordinal, start, end, heading, text) VALUES(?, ?, ?, ?, ?, ?, ?)',
      )
      for (const chunk of chunks)
        insert.run(
          uuid(`${versionId}:${chunk.ordinal}`),
          versionId,
          chunk.ordinal,
          chunk.start,
          chunk.end,
          chunk.heading,
          chunk.text,
        )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { versionId, chunks: this.chunks(versionId) }
  }
  chunks(versionId: string): Passage[] {
    return this.store.db
      .prepare(
        `SELECT ${passageColumns} FROM rag_chunks c JOIN rag_versions v ON v.id=c.version_id WHERE v.id=? ORDER BY c.ordinal`,
      )
      .all(versionId) as unknown as Passage[]
  }
  passage(id: string): Passage {
    const row = this.store.db
      .prepare(
        `SELECT ${passageColumns} FROM rag_chunks c JOIN rag_versions v ON v.id=c.version_id WHERE c.id=?`,
      )
      .get(id)
    if (!row) throw new HttpError(404, '没有找到原文片段。')
    // Staged, never-published imports must not become public through guessed identifiers.
    if (
      !this.store.db
        .prepare('SELECT 1 FROM rag_published_versions WHERE id=?')
        .get(row.versionId as string)
    )
      throw new HttpError(404, '没有找到原文片段。')
    return row as unknown as Passage
  }
  publish(versionId: string, expected: string | null) {
    const db = this.store.db
    const version = db
      .prepare('SELECT document_id, title FROM rag_versions WHERE id=?')
      .get(versionId)
    if (!version) throw new HttpError(404, '没有找到待发布的文献版本。')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (this.current(version.document_id as string) !== expected)
        throw new HttpError(409, '文献在建索引期间已被更新，请重新导入。')
      if (versionId === expected) {
        db.exec('COMMIT')
        return
      }
      db.prepare(
        'DELETE FROM rag_fts WHERE rowid IN (SELECT rowid FROM rag_chunks WHERE version_id=?)',
      ).run(expected)
      const insert = db.prepare('INSERT INTO rag_fts(rowid, title, body) VALUES(?, ?, ?)')
      for (const chunk of db
        .prepare('SELECT rowid, text FROM rag_chunks WHERE version_id=?')
        .all(versionId))
        insert.run(
          chunk.rowid!,
          terms(version.title as string).join(' '),
          terms(chunk.text as string).join(' '),
        )
      db.prepare(
        'INSERT INTO rag_documents VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET version_id=excluded.version_id',
      ).run(version.document_id!, versionId)
      db.prepare('INSERT OR IGNORE INTO rag_published_versions VALUES(?)').run(versionId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  lexical(query: string, limit = 40): string[] {
    if (typeof query !== 'string' || query.length > 8000 || !query.isWellFormed())
      throw new HttpError(400, '检索问题须为有效文本，最长 8000 个字符。')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new HttpError(400, '检索返回数量须为 1–100。')
    const tokens = [...new Set(terms(query))].slice(0, 64)
    if (!tokens.length) return []
    const match = tokens.map((word) => `"${word.replaceAll('"', '""')}"`).join(' OR ')
    return this.store.db
      .prepare(
        `SELECT c.id FROM rag_fts f JOIN rag_chunks c ON c.rowid=f.rowid
      WHERE rag_fts MATCH ? ORDER BY bm25(rag_fts, 5, 1), c.id LIMIT ?`,
      )
      .all(match, limit)
      .map((row) => row.id as string)
  }
  activePassages(ids: string[]): Passage[] {
    if (ids.length > 256) throw new HttpError(400, '一次最多读取 256 个候选片段。')
    if (!ids.length) return []
    return this.store.db
      .prepare(
        `SELECT ${passageColumns} FROM rag_chunks c
      JOIN rag_versions v ON v.id=c.version_id JOIN rag_documents d ON d.version_id=v.id
      WHERE c.id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as unknown as Passage[]
  }
  list(limit = 50, offset = 0) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new HttpError(400, '文献分页参数无效。')
    return this.store.db
      .prepare(
        `SELECT d.id, v.id AS versionId, v.title, v.source_url AS sourceUrl,
      v.published_at AS publishedAt FROM rag_documents d JOIN rag_versions v ON v.id=d.version_id
      ORDER BY v.title, d.id LIMIT ? OFFSET ?`,
      )
      .all(limit, offset)
  }
  count() {
    return Number(this.store.db.prepare('SELECT count(*) AS count FROM rag_documents').get()!.count)
  }
}
