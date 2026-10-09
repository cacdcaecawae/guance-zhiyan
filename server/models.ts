import { randomUUID } from 'node:crypto'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
  type DeepSeekAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { ModelCatalog, ModelSelection } from '../src/types/index.ts'
import { HttpError } from './store.ts'

const providers = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    key: 'DEEPSEEK_API_KEY',
    baseEnv: 'DEEPSEEK_BASE_URL',
    base: 'https://api.deepseek.com/anthropic',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  },
  {
    id: 'qianwen',
    name: '千问 AI 平台',
    key: 'QIANWEN_API_KEY',
    baseEnv: 'QIANWEN_BASE_URL',
    base: 'https://maas.qianwenaiapi.com/apps/anthropic',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro（0813）' },
    ],
  },
  {
    // 校内 GPUStack（vLLM），仅校园网可达；没有联网搜索，看图能力未验证，按纯文本声明。
    id: 'campus',
    name: '校内模型',
    key: 'CAMPUS_API_KEY',
    baseEnv: 'CAMPUS_BASE_URL',
    base: 'http://10.27.66.12',
    models: [
      { id: 'step-3.7-flash', name: 'Step 3.7 Flash' },
      { id: 'qwen3.8-27b', name: 'Qwen3.8 27B' },
    ],
  },
]
export const defaultSelection: ModelSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
}
export function modelCatalog(testAdapter = false): ModelCatalog {
  return {
    providers: providers.map(({ id, name, key, models }) => ({
      id,
      name,
      models,
      configured: testAdapter || !!process.env[key]?.trim(),
    })),
    defaultSelection,
  }
}
export function validateSelection(value: unknown): ModelSelection {
  if (value && typeof value === 'object' && 'provider' in value && 'model' in value) {
    const provider = providers.find((item) => item.id === value.provider)
    if (provider?.models.some((model) => model.id === value.model))
      return { provider: provider.id, model: value.model as string }
  }
  throw new HttpError(400, '请选择支持的供应商和模型。')
}
export function connection(selection: ModelSelection) {
  const provider = providers.find((item) => item.id === selection.provider)!
  return {
    ...provider,
    baseURL: (process.env[provider.baseEnv]?.trim() || provider.base).replace(/\/$/, ''),
    apiKey: process.env[provider.key]?.trim(),
  }
}
// ponytail: 校内 vLLM 0.28 的 Anthropic 流不标准（块起始缺 thinking/text/input 字段，思考增量放在 text 字段，
// 并行工具调用时在已结束的文本块上补发空白增量），DSH 适配器只用全局 fetch，故按校内地址包一层修正。
// 学校升级 vLLM 或改用 OpenAI 格式适配器后删除。
export function fixCampusEvent(event: any, closed: Set<number>) {
  const block = event.content_block
  if (block?.type === 'thinking') block.thinking ??= ''
  if (block?.type === 'text') block.text ??= ''
  if (block?.type === 'tool_use') block.input ??= {}
  const delta = event.delta
  if (delta?.type === 'thinking_delta' && delta.thinking === undefined) {
    delta.thinking = delta.text
    delete delta.text
  }
  if (event.type === 'content_block_stop') closed.add(event.index)
  // 已结束块上的纯空白文本改为 DSH 会跳过的 ping；有内容的迟到增量照常交给 DSH 报错，不静默丢弃
  if (
    event.type === 'content_block_delta' &&
    closed.has(event.index) &&
    delta?.type === 'text_delta' &&
    !delta.text?.trim()
  )
    return { type: 'ping' }
  return event
}
// event: 行按修正后的类型重写（DSH 校验它与 data.type 一致），原 event: 行丢弃
function fixCampusLine(line: string, closed: Set<number>) {
  if (line.startsWith('event:')) return undefined
  if (!line.startsWith('data:')) return line
  try {
    const event = fixCampusEvent(JSON.parse(line.slice(5)), closed)
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}`
  } catch {
    return line
  }
}
export function campusFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream') ||
      !url.startsWith(connection({ provider: 'campus', model: '' }).baseURL + '/')
    )
      return response
    let rest = ''
    const closed = new Set<number>()
    const body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream<string, string>({
          transform(chunk, controller) {
            const lines = (rest + chunk).split('\n')
            rest = lines.pop()!
            for (const line of lines) {
              const fixed = fixCampusLine(line, closed)
              if (fixed !== undefined) controller.enqueue(fixed + '\n')
            }
          },
          flush(controller) {
            const fixed = rest && fixCampusLine(rest, closed)
            if (fixed) controller.enqueue(fixed)
          },
        }),
      )
      .pipeThrough(new TextEncoderStream())
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
globalThis.fetch = campusFetch(globalThis.fetch)

export function modelAdapter(
  provider: string,
  attachments: DeepSeekAdapterOptions['resolveAttachments'],
) {
  const anonymous = randomUUID() as ReturnType<DeepSeekAdapterOptions['resolveUserId']>
  return new DeepSeekAdapter({
    options: () => {
      const config = connection({ provider, model: '' })
      return resolveAdapterOptions({
        apiKeyEnv: config.key,
        baseURL: config.baseURL,
        thinking: 'enabled',
        reasoningEffort: 'high',
        // DeepSeek 与千问按可看图声明，校内模型按纯文本；官方 Flash 沿用适配器默认表的 in-history 声明。
        models: config.models.map(({ id }) => ({
          id,
          inputModalities: provider === 'campus' ? ['text'] : ['text', 'image'],
          // 校内模型上下文 262144；DSH 默认输出 256000 会与输入相加超限，输出（含思考）限 32768。
          ...(provider === 'campus' && { contextWindow: 262144, maxTokens: 32768 }),
          ...(id === 'deepseek-flash' && { systemPromptUpdate: 'in-history' as const }),
        })),
      })
    },
    resolveAttachments: attachments,
    resolveApiKey: async (config) => {
      const key = process.env[config.apiKeyEnv]?.trim()
      if (!key) throw new Error('供应商密钥尚未配置。')
      return key
    },
    resolveUserId: () => anonymous,
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
}
