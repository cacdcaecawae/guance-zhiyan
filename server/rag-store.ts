import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { Store, HttpError } from './store.ts'
import { chunkText } from './rag-chunks.ts'

export interface DocumentInput {
  id: string
  title: string
  text: string
  sourceUrl?: string
  publishedAt?: string
}
/** Filtering metadata imported separately (`pnpm rag metadata`); keys follow the source export. */
export interface DocumentMetadata {
  id: string
  area: string[]
  level: string | null
  period: string | null
  year: number | null
  docType: string | null
  outline: boolean
}
export interface LibraryFilter {
  area?: string
  period?: string
  docType?: string
  year?: number
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
  /** Only from neighbors(): 1 when this is the document's current version, 0 when replaced. */
  current?: number
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
export function terms(text: string) {
  return [...segmenter.segment(text)].filter((part) => part.isWordLike).map((part) => part.segment)
}
/** Function characters that match nearly every passage on their own. */
const STOP_CHARACTERS = new Set('的了和与及或在是对为等把被从向于以之其而并也就都又将由这那有个')

/**
 * Adjacent single characters (碳/达/峰) become a phrase; an isolated one, including one separated
 * by a space or punctuation (碳 税, 碳、税), is kept as a keyword unless it is a function character.
 */
export function lexicalQuery(query: string) {
  const parts: string[] = []
  let run: string[] = []
  const flush = () => {
    if (run.length > 1 || (run.length === 1 && !STOP_CHARACTERS.has(run[0])))
      parts.push(run.join(' '))
    run = []
  }
  for (const { segment, isWordLike } of segmenter.segment(query))
    if (!isWordLike) flush()
    else if ([...segment].length === 1) run.push(segment)
    else {
      flush()
      parts.push(segment)
    }
  flush()
  return [...new Set(parts)]
    .slice(0, 16)
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(' OR ')
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

/** 十四五 / “十四五”时期 / 第十四个五年规划 → 十四五; undefined when no plan period is named. */
export function periodOf(text: string) {
  const ordinal = /第(九|十[一二三四五]?)个五年/.exec(text)
  if (ordinal) return ordinal[1] + '五'
  return /九五|十[一二三四五]?五/.exec(text)?.[0]
}

export function metadataInput(value: unknown): DocumentMetadata {
  if (!value || typeof value !== 'object') throw new HttpError(400, '元数据必须是 JSON 对象。')
  const input = value as Record<string, unknown>
  const label = (key: string) => {
    const text = input[key]
    if (text === undefined || text === null || text === '') return null
    if (typeof text !== 'string' || text.length > 64 || !text.isWellFormed())
      throw new HttpError(400, `元数据 ${key} 须为不超过 64 个字符的文本。`)
    return text.trim() || null
  }
  const id = input.id
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || !id.isWellFormed())
    throw new HttpError(400, '元数据 id 须为非空有效文本，最长 256 个字符。')
  const area = input.area ?? []
  if (
    !Array.isArray(area) ||
    area.length > 10 ||
    area.some((part) => typeof part !== 'string' || !part.trim() || part.length > 64)
  )
    throw new HttpError(400, '元数据 area 须为不超过 10 级的地区名称数组。')
  const year = input.year ?? null
  if (
    year !== null &&
    (!Number.isSafeInteger(year) || (year as number) < 1900 || (year as number) > 2100)
  )
    throw new HttpError(400, '元数据 year 须为 1900–2100 的整数。')
  if (input.outline !== undefined && typeof input.outline !== 'boolean')
    throw new HttpError(400, '元数据 outline 须为布尔值。')
  return {
    id,
    area: (area as string[]).map((part) => part.trim()),
    level: label('level'),
    period: label('period'),
    year: year as number | null,
    docType: label('doc_type'),
    outline: input.outline === true,
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
      CREATE TABLE IF NOT EXISTS rag_metadata(
        document_id TEXT PRIMARY KEY, area TEXT NOT NULL, level TEXT, period TEXT, year INTEGER,
        doc_type TEXT, outline INTEGER NOT NULL
      );
    `)
  }
  saveMetadata(rows: DocumentMetadata[]) {
    const db = this.store.db
    const upsert = db.prepare(
      `INSERT INTO rag_metadata VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET
      area=excluded.area, level=excluded.level, period=excluded.period, year=excluded.year,
      doc_type=excluded.doc_type, outline=excluded.outline`,
    )
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows)
        upsert.run(
          row.id,
          JSON.stringify(row.area),
          row.level,
          row.period,
          row.year,
          row.docType,
          +row.outline,
        )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  /**
   * Current documents matching every given field. An area matches any level of a document's area
   * path, exactly when possible, otherwise by prefix either way (驻马店 ↔ 驻马店市, 安徽省 ↔ 安徽).
   * ponytail: scans rag_metadata per query (~53k rows); index area parts if filters get slow.
   */
  documentIds(filter: LibraryFilter): string[] {
    const where: string[] = []
    const params: (string | number)[] = []
    for (const [column, value] of [
      ['m.period', filter.period],
      ['m.doc_type', filter.docType],
      ['m.year', filter.year],
    ] as const)
      if (value !== undefined) {
        where.push(`${column}=?`)
        params.push(value)
      }
    const run = (clause?: string, extra: string[] = []) =>
      this.store.db
        .prepare(
          `SELECT m.document_id AS id FROM rag_metadata m JOIN rag_documents d ON d.id=m.document_id
          WHERE ${[...where, ...(clause ? [clause] : [])].join(' AND ') || '1'}`,
        )
        .all(...params, ...extra)
        .map((row) => row.id as string)
    const area = filter.area
    if (!area) return run()
    if (/^(全国|国家|中央|中国)$/.test(area)) return run("m.level='国家'")
    const exact = run('EXISTS(SELECT 1 FROM json_each(m.area) a WHERE a.value=?)', [area])
    return exact.length
      ? exact
      : run(
          `EXISTS(SELECT 1 FROM json_each(m.area) a WHERE a.value<>'全国' AND
          (substr(a.value, 1, length(?))=? OR substr(?, 1, length(a.value))=a.value))`,
          [area, area, area],
        )
  }
  /** Documents in scope for library_list, ordered by period and year so a series reads in order. */
  listDocuments(filter: LibraryFilter, title?: string, limit = 50) {
    const ids = this.documentIds(filter)
    const rows = this.store.db
      .prepare(
        `SELECT d.id AS documentId, v.title, m.area, m.period, m.year, m.doc_type AS docType,
        m.outline FROM rag_documents d JOIN rag_versions v ON v.id=d.version_id
        JOIN rag_metadata m ON m.document_id=d.id
        WHERE d.id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR instr(v.title, ?) > 0)
        ORDER BY m.period, m.year, v.title, d.id`,
      )
      .all(JSON.stringify(ids), title ?? null, title ?? null)
    return {
      total: rows.length,
      documents: rows.slice(0, limit).map((row) => ({
        documentId: row.documentId as string,
        title: row.title as string,
        area: (JSON.parse(row.area as string) as string[])
          .filter((part) => part !== '全国')
          .join('/'),
        ...(row.period ? { period: row.period as string } : {}),
        ...(row.year ? { year: row.year as number } : {}),
        ...(row.docType ? { docType: row.docType as string } : {}),
        ...(row.outline ? { outline: true } : {}),
      })),
    }
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
        'chunks-v2',
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
    // Tokenize before taking the write lock: the web server waits on it while this CLI holds it.
    const title = terms(version.title as string).join(' ')
    const rows =
      versionId === expected
        ? []
        : db
            .prepare('SELECT rowid, ordinal, text FROM rag_chunks WHERE version_id=?')
            .all(versionId)
            .map(
              (chunk) =>
                [chunk.rowid!, chunk.ordinal === 0, terms(chunk.text as string).join(' ')] as const,
            )
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
      // The title is indexed once per document, so a title match yields one candidate rather than
      // every chunk of a long document.
      const insert = db.prepare('INSERT INTO rag_fts(rowid, title, body) VALUES(?, ?, ?)')
      for (const [rowid, first, body] of rows) insert.run(rowid, first ? title : '', body)
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
  /** BM25 scores every match of a common word, so the query runs off the main thread. */
  async lexical(
    query: string,
    limit = 40,
    signal?: AbortSignal,
    documentIds?: string[],
  ): Promise<string[]> {
    const match = lexicalQuery(query)
    if (!match) return []
    // ponytail: one short-lived worker per query (~30 ms start, cold page cache); keep a
    // resident worker if full-library latency needs it.
    const worker = new Worker(new URL('./rag-lexical.ts', import.meta.url), {
      workerData: { path: this.store.path, match, limit, documentIds },
      // Process-level flags of the parent (e.g. under node --test) are invalid in a worker.
      execArgv: ['--disable-warning=ExperimentalWarning'],
    })
    // A failure racing with cancellation must not become an unhandled 'error' event.
    worker.on('error', () => {})
    try {
      const [ids] = await once(worker, 'message', signal ? { signal } : {})
      return ids as string[]
    } finally {
      // Wait for exit so the read-only handle is closed before callers close or delete the store.
      await worker.terminate()
    }
  }
  /** Adjacent passages of the same published version, for reading a citation in context. */
  neighbors(id: string, before: number, after: number): Passage[] {
    const passage = this.passage(id)
    return this.store.db
      .prepare(
        `SELECT ${passageColumns}, d.version_id IS v.id AS current
      FROM rag_chunks c JOIN rag_versions v ON v.id=c.version_id
      LEFT JOIN rag_documents d ON d.id=v.document_id
      WHERE c.version_id=? AND c.ordinal BETWEEN ? AND ? ORDER BY c.ordinal`,
      )
      .all(
        passage.versionId,
        passage.ordinal - before,
        passage.ordinal + after,
      ) as unknown as Passage[]
  }
  activePassages(ids: string[]): Passage[] {
    if (ids.length > 256) throw new HttpError(400, '一次最多读取 256 个候选片段。')
    if (!ids.length) return []
    // Join by the document primary key so SQLite looks up candidates instead of scanning the library.
    return this.store.db
      .prepare(
        `SELECT ${passageColumns} FROM rag_chunks c
      JOIN rag_versions v ON v.id=c.version_id
      JOIN rag_documents d ON d.id=v.document_id AND d.version_id=v.id
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
