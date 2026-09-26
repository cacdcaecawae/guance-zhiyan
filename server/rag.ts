import { Embeddings, type EmbeddingConfig } from './rag-embedding.ts'
import { createHash } from 'node:crypto'
import { Qdrant } from './rag-qdrant.ts'
import { LibraryStore, documentInput, type DocumentInput, type Passage } from './rag-store.ts'

export const RAG_ERRORS = {
  RAG_NOT_CONFIGURED: '后端尚未配置文献库向量服务，请联系管理员。',
  RAG_EMPTY: '共享文献库尚未导入资料，请联系管理员。',
  RAG_NOT_INDEXED: '当前向量模型的文献索引尚未完成，请联系管理员重建索引。',
  RAG_RETRIEVAL_FAILED: '文献库检索失败，请检查后端配置与检索服务后重试。',
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
    },
    qdrant: {
      url: env.QDRANT_URL?.trim() || 'http://127.0.0.1:6333',
      apiKey: env.QDRANT_API_KEY?.trim() || undefined,
    },
  }
}

/** SQLite is authoritative; vector results must resolve to a current published version. */
export class KnowledgeLibrary {
  readonly documents: LibraryStore
  readonly embeddings?: Embeddings
  readonly vectors?: Qdrant
  readonly indexFingerprint?: string
  constructor(documents: LibraryStore, config?: RagConfig) {
    this.documents = documents
    if (config) {
      this.embeddings = new Embeddings(config.embedding)
      this.indexFingerprint = createHash('sha256')
        .update(JSON.stringify([new URL(config.qdrant.url).href, this.embeddings.fingerprint]))
        .digest('hex')
      this.vectors = new Qdrant({
        ...config.qdrant,
        collection: `rag_v1_${this.embeddings.fingerprint}`,
        dimensions: config.embedding.dimensions,
      })
    }
    documents.store.db.exec(`CREATE TABLE IF NOT EXISTS rag_indexed_versions(
      fingerprint TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES rag_versions(id),
      PRIMARY KEY(fingerprint, version_id)
    );`)
  }

  private configured() {
    if (!this.embeddings || !this.vectors) throw new RagError('RAG_NOT_CONFIGURED')
    return { embeddings: this.embeddings, vectors: this.vectors }
  }

  /** Admin imports are serialized by the CLI lock; failed imports can be retried unchanged. */
  async import(input: DocumentInput, signal?: AbortSignal) {
    signal?.throwIfAborted()
    input = documentInput(input)
    const { embeddings, vectors } = this.configured()
    const previous = this.documents.current(input.id)
    const staged = this.documents.stage(input)
    await vectors.ensureCollection(signal, () => {
      this.documents.store.db
        .prepare('DELETE FROM rag_indexed_versions WHERE fingerprint=?')
        .run(this.indexFingerprint!)
    })
    // Bound memory to a batch rather than holding a full document's vectors.
    for (let offset = 0; offset < staged.chunks.length; offset += 16) {
      const batch = staged.chunks.slice(offset, offset + 16)
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
    // Also retry cleanup after a crash between publication and deletion. Old source text stays.
    const obsolete = this.documents.store.db
      .prepare(
        `SELECT c.id FROM rag_chunks c JOIN rag_versions v ON v.id=c.version_id
        WHERE v.document_id=? AND v.id<>?`,
      )
      .all(input.id, staged.versionId)
      .map((row) => row.id as string)
    for (let offset = 0; offset < obsolete.length; offset += 128)
      await vectors.delete(obsolete.slice(offset, offset + 128), signal)
    return { versionId: staged.versionId, chunks: staged.chunks.length }
  }

  async retrieve(query: string, signal?: AbortSignal): Promise<Passage[]> {
    signal?.throwIfAborted()
    if (!query.trim() || query.length > 8000 || !query.isWellFormed())
      throw new Error('检索问题须为 1–8000 个有效字符。')
    const { embeddings, vectors } = this.configured()
    if (!this.documents.count()) throw new RagError('RAG_EMPTY')
    const assertIndexed = () => {
      const missing = this.documents.store.db
        .prepare(
          `SELECT 1 FROM rag_documents d WHERE NOT EXISTS(
        SELECT 1 FROM rag_indexed_versions i WHERE i.version_id=d.version_id AND i.fingerprint=?
      ) LIMIT 1`,
        )
        .get(this.indexFingerprint!)
      if (missing) throw new RagError('RAG_NOT_INDEXED')
    }
    assertIndexed()
    try {
      const [encoded] = await embeddings.embed([query], signal)
      const dense: string[] = []
      // ponytail: scan at most 10k candidates; finish import cleanup if abandoned vectors exceed this.
      for (let offset = 0; ; offset += 80) {
        if (offset >= 10_000) throw new Error('Too many stale candidates; finish import cleanup.')
        const page = await vectors.search(encoded, 80, signal, offset)
        const active = new Set(
          this.documents.activePassages(page.map((hit) => hit.id)).map((p) => p.id),
        )
        dense.push(...page.filter((hit) => active.has(hit.id)).map((hit) => hit.id))
        if (dense.length >= 80 || page.length < 80) break
      }
      signal?.throwIfAborted()
      const lexical = this.documents.lexical(query, 40)
      const scores = new Map<string, number>()
      for (const ranked of [dense.slice(0, 80), lexical])
        [...new Set(ranked)].forEach((id, rank) =>
          scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1)),
        )
      const passages = this.documents.activePassages([...scores.keys()])
      const results = passages
        .sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || a.id.localeCompare(b.id))
        .slice(0, 8)
      assertIndexed()
      return results
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof RagError) throw error
      throw new RagError('RAG_RETRIEVAL_FAILED')
    }
  }
}
