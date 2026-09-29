import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export type EmbeddingConfig = {
  url: string
  model: string
  dimensions: number
  apiKey?: string
  /** Inputs per request; some services accept at most 10 (DashScope text-embedding-v3/v4). */
  batchSize?: number
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** Worth retrying: timeouts, network failures, rate limits and server errors. */
class TransientError extends Error {}

export class Embeddings {
  readonly fingerprint: string
  readonly batchSize: number
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
    this.batchSize = config.batchSize ?? 10
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1)
      throw new Error('向量批量条数须为正整数。')
    this.config = { ...config, url: url.href }
    this.fingerprint = createHash('sha256')
      .update(JSON.stringify([url.href, config.model, config.dimensions]))
      .digest('hex')
  }

  /** Rate limits, 5xx and network failures are retried with backoff; other errors fail at once. */
  async embed(texts: string[], signal?: AbortSignal, retries = 3): Promise<number[][]> {
    if (signal?.aborted) throw new DOMException('向量请求已取消。', 'AbortError')
    if (texts.some((text) => typeof text !== 'string' || !text.trim()))
      throw new Error('向量输入不能为空。')
    const vectors: number[][] = []
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const input = texts.slice(start, start + this.batchSize)
      for (let attempt = 0; ; attempt++)
        try {
          vectors.push(...(await this.batch(input, signal)))
          break
        } catch (error) {
          if (!(error instanceof TransientError) || attempt >= retries) throw error
          await delay(500 * 2 ** attempt, undefined, { signal })
        }
    }
    return vectors
  }

  private async batch(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const timeout = AbortSignal.timeout(30_000)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const requestError = (error?: unknown) => {
      if (signal?.aborted) return new DOMException('向量请求已取消。', 'AbortError')
      if (timeout.aborted) return new TransientError('向量服务响应超时，请重试。')
      // A redirect is a configuration problem; retrying cannot fix it.
      const redirected = /redirect/i.test(String((error as { cause?: unknown } | undefined)?.cause))
      return new (redirected ? Error : TransientError)('向量服务请求失败，请检查配置后重试。')
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
    } catch (error) {
      throw requestError(error)
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      const message = `向量服务请求失败（HTTP ${response.status}）。`
      throw response.status === 429 || response.status >= 500
        ? new TransientError(message)
        : new Error(message)
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
    return Array.from({ length: input.length }, (_, index) => batch.get(index)!)
  }
}
