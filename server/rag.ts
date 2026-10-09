import { Embeddings, type EmbeddingConfig } from './rag-embedding.ts'
import { createHash, randomUUID } from 'node:crypto'
import { Qdrant } from './rag-qdrant.ts'
import {
  LibraryStore,
  documentInput,
  type DocumentInput,
  type LibraryFilter,
  type Passage,
} from './rag-store.ts'

export const RAG_ERRORS = {
  RAG_NOT_CONFIGURED: '后端尚未配置文献库向量服务，请联系管理员。',
  RAG_EMPTY: '共享文献库尚未导入资料，请联系管理员。',
  RAG_NOT_INDEXED: '文献索引尚未完成或在检索期间发生重建，请重试或联系管理员。',
  RAG_RETRIEVAL_FAILED: '文献库检索失败，请稍后重试或联系管理员。',
  RAG_INVALID_QUERY: '检索词须为 1–1000 个有效字符。',
  RAG_INVALID_FILTER:
    '筛选条件无效：至少给出一个条件；地区、标题关键词不超过 64 个字符，规划期写作“十四五”这类形式，年份为 1900–2100 的整数。',
  RAG_PASSAGE_NOT_FOUND: '没有找到该原文片段。',
  RAG_NO_METADATA: '文献库尚未导入元数据，暂不能按地区、规划期或文种筛选；请去掉筛选条件后重试。',
} as const

export class RagError extends Error {
  readonly code: keyof typeof RAG_ERRORS
  constructor(code: keyof typeof RAG_ERRORS) {
    super(RAG_ERRORS[code])
    this.code = code
  }
}

export type RagConfig = {
  embedding: EmbeddingConfig
  qdrant: { url: string; apiKey?: string }
}

export function ragConfig(env: NodeJS.ProcessEnv = process.env): RagConfig | undefined {
  const values = [env.EMBEDDING_URL, env.EMBEDDING_MODEL, env.EMBEDDING_DIMENSIONS]
  if (values.every((value) => !value?.trim())) return undefined
  if (values.some((value) => !value?.trim()))
    throw new Error('须同时配置 EMBEDDING_URL、EMBEDDING_MODEL 和 EMBEDDING_DIMENSIONS。')
  return {
    embedding: {
      url: env.EMBEDDING_URL!.trim(),
      model: env.EMBEDDING_MODEL!.trim(),
      dimensions: Number(env.EMBEDDING_DIMENSIONS),
      apiKey: env.EMBEDDING_API_KEY?.trim() || undefined,
      batchSize: env.EMBEDDING_BATCH_SIZE?.trim() ? Number(env.EMBEDDING_BATCH_SIZE) : undefined,
    },
    qdrant: {
      url: env.QDRANT_URL?.trim() || 'http://127.0.0.1:6333',
      apiKey: env.QDRANT_API_KEY?.trim() || undefined,
    },
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** SQLite is authoritative; vector results must resolve to a current published version. */
export class KnowledgeLibrary {
  readonly documents: LibraryStore
  readonly embeddings?: Embeddings
  readonly vectors?: Qdrant
  readonly indexFingerprint?: string
  constructor(documents: LibraryStore, config?: RagConfig) {
    this.documents = documents
    const db = documents.store.db
    db.exec(`CREATE TABLE IF NOT EXISTS rag_indexed_versions(
      fingerprint TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES rag_versions(id),
      PRIMARY KEY(fingerprint, version_id)
    );
    CREATE TABLE IF NOT EXISTS rag_index_generations(
      fingerprint TEXT PRIMARY KEY, generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rag_library(one INTEGER PRIMARY KEY CHECK(one=1), id TEXT NOT NULL);`)
    if (config) {
      // A random id per DATA_DIR keeps libraries that share a Qdrant server and embedding model
      // out of each other's collection, where cleanup would delete the other library's points.
      db.prepare('INSERT OR IGNORE INTO rag_library VALUES(1, ?)').run(randomUUID())
      const library = db.prepare('SELECT id FROM rag_library').get()!.id
      this.embeddings = new Embeddings(config.embedding)
      const collection = `rag_v1_${digest([library, this.embeddings.fingerprint])}`
      this.vectors = new Qdrant({
        ...config.qdrant,
        collection,
        dimensions: config.embedding.dimensions,
      })
      // Preserve the usual root endpoint's existing markers. Path-prefix markers used to have
      // independent trailing-slash aliases, any of which may now be stale: never inherit them.
      this.indexFingerprint = digest([
        this.vectors.url,
        collection,
        ...(new URL(this.vectors.url).pathname === '/' ? [] : ['canonical-path-v1']),
      ])
    }
  }

  neighbors(id: string, before: number, after: number) {
    return this.documents.neighbors(id, before, after)
  }

  private requireMetadata() {
    if (!this.documents.store.db.prepare('SELECT 1 FROM rag_metadata LIMIT 1').get())
      throw new RagError('RAG_NO_METADATA')
  }

  /** Current documents in a metadata scope; an empty scope is a valid answer, not an error. */
  scope(filter: LibraryFilter) {
    this.requireMetadata()
    return this.documents.documentIds(filter)
  }

  list(filter: LibraryFilter, title?: string) {
    this.requireMetadata()
    return this.documents.listDocuments(filter, title)
  }

  /** Library tools are offered only when there is something configured to search. */
  available() {
    return !!this.embeddings && this.documents.count() > 0
  }

  /** Until every current document is indexed again, retrieval reports RAG_NOT_INDEXED. */
  invalidate() {
    this.configured()
    const db = this.documents.store.db
    db.exec('BEGIN IMMEDIATE')
    try {
      // A completed rebuild can restore every marker while a query is awaiting a provider.
      // Persist a new generation in the same transaction, visible to all server/CLI processes.
      db.prepare(
        `INSERT INTO rag_index_generations VALUES(?, 1)
        ON CONFLICT(fingerprint) DO UPDATE SET generation=generation+1`,
      ).run(this.indexFingerprint!)
      db.prepare('DELETE FROM rag_indexed_versions WHERE fingerprint=?').run(this.indexFingerprint!)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private indexed(versionId: string) {
    return !!this.documents.store.db
      .prepare('SELECT 1 FROM rag_indexed_versions WHERE fingerprint=? AND version_id=?')
      .get(this.indexFingerprint!, versionId)
  }

  private configured() {
    if (!this.embeddings || !this.vectors) throw new RagError('RAG_NOT_CONFIGURED')
    return { embeddings: this.embeddings, vectors: this.vectors }
  }

  /**
   * Admin imports are serialized by the CLI lock. A document whose current version is already
   * indexed for this vector space is skipped, so an interrupted import or reindex resumes cheaply.
   */
  async import(input: DocumentInput, signal?: AbortSignal) {
    signal?.throwIfAborted()
    input = documentInput(input)
    const { embeddings, vectors } = this.configured()
    const previous = this.documents.current(input.id)
    const staged = this.documents.stage(input)
    await vectors.ensureCollection(signal, () => this.invalidate())
    // Removing an old version's vectors happens after publication; it is repeated on every import
    // of the document so a crash between the two is finished later. Old source text stays.
    const cleanup = async () => {
      const obsolete = this.documents.store.db
        .prepare(
          `SELECT c.id FROM rag_chunks c JOIN rag_versions v ON v.id=c.version_id
          WHERE v.document_id=? AND v.id<>?`,
        )
        .all(input.id, staged.versionId)
        .map((row) => row.id as string)
      for (let offset = 0; offset < obsolete.length; offset += 128)
        await vectors.delete(obsolete.slice(offset, offset + 128), signal)
    }
    if (previous === staged.versionId && this.indexed(staged.versionId)) {
      await cleanup()
      return { versionId: staged.versionId, chunks: staged.chunks.length, skipped: true }
    }
    // Bound memory to a batch rather than holding a full document's vectors.
    for (let offset = 0; offset < staged.chunks.length; offset += embeddings.batchSize) {
      const batch = staged.chunks.slice(offset, offset + embeddings.batchSize)
      const encoded = await embeddings.embed(
        batch.map((chunk) => `${chunk.title}\n${chunk.heading}\n${chunk.text}`),
        signal,
      )
      await vectors.upsert(batch, encoded, signal)
    }
    signal?.throwIfAborted()
    this.documents.store.db
      .prepare('INSERT OR IGNORE INTO rag_indexed_versions VALUES(?, ?)')
      .run(this.indexFingerprint!, staged.versionId)
    this.documents.publish(staged.versionId, previous)
    await cleanup()
    return { versionId: staged.versionId, chunks: staged.chunks.length, skipped: false }
  }

  async retrieve(query: string, signal?: AbortSignal, filter?: LibraryFilter): Promise<Passage[]> {
    signal?.throwIfAborted()
    if (!query.trim() || query.length > 8000 || !query.isWellFormed())
      throw new Error('检索问题须为 1–8000 个有效字符。')
    const { embeddings, vectors } = this.configured()
    if (!this.documents.count()) throw new RagError('RAG_EMPTY')
    const documentIds = filter ? this.scope(filter) : undefined
    if (documentIds && !documentIds.length) return []
    // ponytail: anti-join over all current documents (~29 ms at 53k documents), run before and
    // after the search; record completion per fingerprint if library size makes this matter.
    const assertIndexed = (expected?: number) => {
      // One SQLite snapshot for generation and readiness, including when a separate CLI writes.
      const state = this.documents.store.db
        .prepare(
          `SELECT COALESCE((SELECT generation FROM rag_index_generations WHERE fingerprint=?), 0)
          AS generation, EXISTS(SELECT 1 FROM rag_documents d WHERE NOT EXISTS(
        SELECT 1 FROM rag_indexed_versions i WHERE i.version_id=d.version_id AND i.fingerprint=?
      )) AS missing`,
        )
        .get(this.indexFingerprint!, this.indexFingerprint!)!
      const generation = Number(state.generation)
      if (state.missing || (expected !== undefined && expected !== generation))
        throw new RagError('RAG_NOT_INDEXED')
      return generation
    }
    const generation = assertIndexed()
    const assertGeneration = () => {
      const current =
        this.documents.store.db
          .prepare('SELECT generation FROM rag_index_generations WHERE fingerprint=?')
          .get(this.indexFingerprint!)?.generation ?? 0
      if (current !== generation) throw new RagError('RAG_NOT_INDEXED')
    }
    try {
      const [encoded] = await embeddings.embed([query], signal, 1)
      assertGeneration()
      let dense: string[] = []
      // Every query starts from the top: offset paging could skip current points while an
      // import's cleanup deletes stale points ranked ahead of them.
      for (const limit of [80, 1000]) {
        const hits = await vectors.search(encoded, limit, signal, documentIds)
        assertGeneration()
        const active = new Set<string>()
        for (let offset = 0; offset < hits.length; offset += 256)
          for (const passage of this.documents.activePassages(
            hits.slice(offset, offset + 256).map((hit) => hit.id),
          ))
            active.add(passage.id)
        dense = hits.filter((hit) => active.has(hit.id)).map((hit) => hit.id)
        if (dense.length >= 80 || hits.length < limit) break
        // ponytail: 1000 candidates at most; finish import cleanup if abandoned vectors exceed this.
        if (limit === 1000) throw new Error('Too many stale candidates; finish import cleanup.')
      }
      signal?.throwIfAborted()
      const lexical = await this.documents.lexical(query, 40, signal, documentIds)
      const scores = new Map<string, number>()
      for (const ranked of [dense.slice(0, 80), lexical])
        [...new Set(ranked)].forEach((id, rank) =>
          scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1)),
        )
      const passages = this.documents.activePassages([...scores.keys()])
      const results = passages
        .sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || a.id.localeCompare(b.id))
        .slice(0, 8)
      assertIndexed(generation)
      return results
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof RagError) throw error
      // Client errors are already free of URLs and keys; log the cause for the administrator.
      console.warn('文献库检索失败：', error instanceof Error ? error.message : error)
      throw new RagError('RAG_RETRIEVAL_FAILED')
    }
  }
}
