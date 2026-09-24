import type { WebSearchProvider, WebSearchSource } from '@deepseek-ai/dsh-web'
import { connection } from './models.ts'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** The platform requires this system marker for native search (see README sources). */
export function qianwenSearch(model: string): WebSearchProvider {
  return {
    id: 'qianwen',
    available: () => !!connection({ provider: 'qianwen', model }).apiKey,
    async search(request, signal) {
      const config = connection({ provider: 'qianwen', model })
      if (!config.apiKey) throw new Error('千问平台密钥尚未配置。')
      const response = await fetch(`${config.baseURL.replace(/\/v1$/, '')}/v1/messages`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          thinking: { type: 'disabled' },
          system: 'x-anthropic-billing-header: cc_entrypoint=cli;',
          messages: [{ role: 'user', content: `请联网搜索：${request.query}` }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`千问联网搜索请求失败（${response.status}）。`)
      }
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of response.body!) {
        size += chunk.length
        if (size > 1_000_000) throw new Error('联网搜索响应过大。')
        chunks.push(chunk)
      }
      const content = record(JSON.parse(Buffer.concat(chunks).toString())).content
      if (!Array.isArray(content)) throw new Error('联网搜索响应格式无效。')
      const blocks = content.map(record)
      const results = blocks.filter((block) => block.type === 'web_search_tool_result')
      if (!results.length || results.some((block) => !Array.isArray(block.content)))
        throw new Error('供应商未返回有效联网搜索结果。')
      const snippets = new Map<string, string>()
      for (const block of blocks) {
        if (block.type !== 'text' || !Array.isArray(block.citations)) continue
        for (const item of block.citations.map(record))
          if (typeof item.url === 'string' && typeof item.cited_text === 'string')
            snippets.set(item.url, item.cited_text)
      }
      const sources = new Map<string, WebSearchSource>()
      for (const block of results) {
        for (const item of (block.content as unknown[]).map(record)) {
          if (
            item.type !== 'web_search_result' ||
            typeof item.url !== 'string' ||
            !/^https?:\/\//i.test(item.url)
          )
            continue
          if (!sources.has(item.url))
            sources.set(item.url, {
              url: item.url,
              ...(typeof item.title === 'string' ? { title: item.title } : {}),
              ...(snippets.has(item.url) ? { snippet: snippets.get(item.url) } : {}),
              ...(typeof item.page_age === 'string' ? { publishedAt: item.page_age } : {}),
            })
        }
      }
      return { sources: [...sources.values()], truncated: false }
    },
  }
}
