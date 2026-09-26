import { createHash } from 'node:crypto'

export type EmbeddingConfig = {
  url: string
  model: string
  dimensions: number
  apiKey?: string
}

const BATCH_SIZE = 16
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export class Embeddings {
  readonly fingerprint: string
  private readonly config: EmbeddingConfig

  constructor(config: EmbeddingConfig) {
    let url: URL
    try {
      url = new URL(config.url)
    } catch {
      throw new Error('向量服务地址无效。')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error('向量服务地址必须是无内嵌凭据的 HTTP 或 HTTPS 地址。')
    if (!config.model.trim() || !Number.isSafeInteger(config.dimensions) || config.dimensions < 1)
      throw new Error('向量模型名称和维度配置无效。')
    this.config = { ...config, url: url.href }
    this.fingerprint = createHash('sha256')
      .update(JSON.stringify([url.href, config.model, config.dimensions]))
      .digest('hex')
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (signal?.aborted) throw new DOMException('向量请求已取消。', 'AbortError')
    if (texts.some((text) => typeof text !== 'string' || !text.trim()))
      throw new Error('向量输入不能为空。')
    const vectors: number[][] = []
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const input = texts.slice(start, start + BATCH_SIZE)
      const timeout = AbortSignal.timeout(30_000)
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      const requestError = () => {
        if (signal?.aborted) return new DOMException('向量请求已取消。', 'AbortError')
        return new Error(
          timeout.aborted ? '向量服务响应超时，请重试。' : '向量服务请求失败，请检查配置后重试。',
        )
      }
      let response: Response
      try {
        response = await fetch(this.config.url, {
          method: 'POST',
          redirect: 'error',
          signal: requestSignal,
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            input,
            dimensions: this.config.dimensions,
          }),
        })
      } catch {
        throw requestError()
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`向量服务请求失败（HTTP ${response.status}）。`)
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
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel()
            throw new Error('body too large')
          }
          chunks.push(value)
        }
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        if (requestSignal.aborted) throw requestError()
        throw new Error('向量服务返回无效响应。')
      }
      const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : null
      if (!Array.isArray(data) || data.length !== input.length)
        throw new Error('向量服务返回的条数与输入不符。')
      const batch = new Map<number, number[]>()
      for (const item of data) {
        if (
          !item ||
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= input.length ||
          batch.has(item.index) ||
          !Array.isArray(item.embedding) ||
          item.embedding.length !== this.config.dimensions ||
          item.embedding.some(
            (value: unknown) => typeof value !== 'number' || !Number.isFinite(value),
          ) ||
          !item.embedding.some((value: number) => value !== 0)
        )
          throw new Error('向量服务返回的索引、维度或数值无效。')
        batch.set(item.index, item.embedding)
      }
      for (let index = 0; index < input.length; index++) vectors.push(batch.get(index)!)
    }
    return vectors
  }
}
