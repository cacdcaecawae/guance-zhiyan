import type { Passage } from './rag-store.ts'

export type QdrantConfig = {
  url: string
  apiKey?: string
  collection: string
  dimensions: number
}

const BATCH_SIZE = 64
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('向量索引请求已取消。', 'AbortError')
}

export class Qdrant {
  private readonly config: QdrantConfig
  private readonly collectionURL: string

  constructor(config: QdrantConfig) {
    let url: URL
    try {
      url = new URL(config.url)
    } catch {
      throw new Error('Qdrant 服务地址无效。')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Qdrant 服务地址须为不含凭据、查询参数或片段的 HTTP(S) 地址。')
    if (
      !/^[a-z0-9][a-z0-9._-]{0,254}$/i.test(config.collection) ||
      !Number.isSafeInteger(config.dimensions) ||
      config.dimensions < 1
    )
      throw new Error('Qdrant 集合名称或向量维度配置无效。')
    this.config = { ...config }
    this.collectionURL = `${url.href.replace(/\/+$/, '')}/collections/${encodeURIComponent(config.collection)}`
  }

  async ensureCollection(signal?: AbortSignal, onMissing?: () => void): Promise<boolean> {
    let collection = await this.request('GET', '', undefined, signal, [404])
    const wasMissing = collection === undefined
    if (wasMissing) {
      // Persist invalidation first: creation can succeed even if verification or this process fails.
      onMissing?.()
      const created = await this.request(
        'PUT',
        '?timeout=25',
        { vectors: { size: this.config.dimensions, distance: 'Cosine' } },
        signal,
        [400, 409],
      )
      if (created !== true && created !== undefined) throw new Error('Qdrant 未确认集合创建成功。')
      // Concurrent initializers may create the collection first; verify its actual configuration.
      collection = await this.request('GET', '', undefined, signal)
    }
    const vectors = record(record(record(record(collection).config).params).vectors)
    if (vectors.size !== this.config.dimensions || vectors.distance !== 'Cosine')
      throw new Error('Qdrant 集合的向量维度或距离类型不兼容，请使用对应模型的索引集合。')
    return wasMissing
  }

  async upsert(
    passages: Pick<Passage, 'id' | 'documentId' | 'versionId'>[],
    vectors: number[][],
    signal?: AbortSignal,
  ): Promise<void> {
    cancelled(signal)
    if (passages.length !== vectors.length) throw new Error('片段与向量条数不符。')
    const seen = new Set<string>()
    for (const [index, passage] of passages.entries()) {
      if (
        !UUID.test(passage.id) ||
        !UUID.test(passage.versionId) ||
        typeof passage.documentId !== 'string' ||
        !passage.documentId.trim() ||
        seen.has(passage.id)
      )
        throw new Error('向量索引片段标识无效或重复。')
      seen.add(passage.id)
      this.validateVector(vectors[index])
    }
    for (let start = 0; start < passages.length; start += BATCH_SIZE) {
      const points = passages.slice(start, start + BATCH_SIZE).map((passage, index) => ({
        id: passage.id,
        vector: vectors[start + index],
        payload: { documentId: passage.documentId, versionId: passage.versionId },
      }))
      const result = await this.request('PUT', '/points?wait=true&timeout=25', { points }, signal)
      if (record(result).status !== 'completed') throw new Error('Qdrant 尚未完成向量写入。')
    }
  }

  async search(
    vector: number[],
    limit: number,
    signal?: AbortSignal,
    offset = 0,
  ): Promise<{ id: string; score: number }[]> {
    this.validateVector(vector)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('向量检索条数须为 1 至 1000 的整数。')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000)
      throw new Error('向量检索偏移须为 0 至 10000 的整数。')
    const result = await this.request(
      'POST',
      '/points/query?timeout=25',
      { query: vector, limit, offset, with_payload: false, with_vector: false },
      signal,
    )
    const points = record(result).points
    if (!Array.isArray(points) || points.length > limit) throw new Error('Qdrant 检索响应无效。')
    const seen = new Set<string>()
    return points.map((point: unknown) => {
      const { id, score } = record(point)
      if (
        typeof id !== 'string' ||
        !UUID.test(id) ||
        seen.has(id) ||
        typeof score !== 'number' ||
        !Number.isFinite(score)
      )
        throw new Error('Qdrant 返回的片段标识或得分无效。')
      seen.add(id)
      return { id, score }
    })
  }

  async delete(ids: string[], signal?: AbortSignal): Promise<void> {
    cancelled(signal)
    if (ids.some((id) => !UUID.test(id))) throw new Error('待删除的向量片段标识无效。')
    for (let start = 0; start < ids.length; start += BATCH_SIZE) {
      const result = await this.request(
        'POST',
        '/points/delete?wait=true&timeout=25',
        { points: ids.slice(start, start + BATCH_SIZE) },
        signal,
      )
      if (record(result).status !== 'completed') throw new Error('Qdrant 尚未完成向量删除。')
    }
  }

  private validateVector(vector: number[]) {
    if (
      !Array.isArray(vector) ||
      vector.length !== this.config.dimensions ||
      vector.some((value) => typeof value !== 'number' || !Number.isFinite(Math.fround(value))) ||
      !vector.some((value) => Math.fround(value) !== 0)
    )
      throw new Error('向量维度或数值无效。')
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    allowedStatuses: number[] = [],
  ): Promise<unknown> {
    cancelled(signal)
    const timeout = AbortSignal.timeout(30_000)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const networkError = () => {
      cancelled(signal)
      return new Error(
        timeout.aborted ? 'Qdrant 请求超时，请重试。' : 'Qdrant 请求失败，请检查服务配置。',
      )
    }
    let response: Response
    try {
      response = await fetch(this.collectionURL + path, {
        method,
        redirect: 'error',
        signal: requestSignal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { 'api-key': this.config.apiKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw networkError()
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      cancelled(signal)
      if (allowedStatuses.includes(response.status)) return undefined
      throw new Error(`Qdrant 请求失败（HTTP ${response.status}）。`)
    }
    let payload: unknown
    try {
      const reader = response.body?.getReader()
      if (!reader) throw new Error('empty body')
      const chunks: Uint8Array[] = []
      let bytes = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 2 * 1024 * 1024) {
          await reader.cancel()
          throw new Error('body too large')
        }
        chunks.push(value)
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      if (requestSignal.aborted) throw networkError()
      throw new Error('Qdrant 返回无效响应。')
    }
    const envelope = record(payload)
    if (envelope.status !== 'ok' || !('result' in envelope) || envelope.result === undefined)
      throw new Error('Qdrant 返回无效响应。')
    return envelope.result
  }
}
