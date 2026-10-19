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
      { id: 'deepseek-v4-flash-0731-w8a8', name: 'DeepSeek V4 Flash（校内 W8A8）' },
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
// 校内 GPUStack（vLLM）的 Anthropic 接口关不掉 qwen 的思考：thinking disabled、budget_tokens、预填空思考都无效；
// OpenAI 接口的 chat_template_kwargs.enable_thinking=false 才有效，而思考约占慢题输出的三分之二（评测迭代 22）。
// DSH 只有 Messages 适配器且只用全局 fetch，故把发往校内 /v1/messages 的请求改发 /v1/chat/completions，
// 再把 OpenAI 流转回标准 Messages 事件。
// ponytail: 只转换本项目用到的字段（文本、工具调用与结果、用量）；校内模型按纯文本接入，不收图片。
type Block = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | Block[]
}
const blockText = (content: string | Block[] | undefined) =>
  typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')

/** A Messages request body as an OpenAI chat request with thinking off. */
export function toChatRequest(body: any) {
  const messages: object[] = body.system ? [{ role: 'system', content: body.system }] : []
  for (const message of body.messages) {
    const blocks: Block[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content
    if (message.role === 'assistant') {
      const calls = blocks.filter((block) => block.type === 'tool_use')
      messages.push({
        role: 'assistant',
        content: blockText(blocks) || null, // earlier thinking blocks are dropped
        ...(calls.length && {
          tool_calls: calls.map((block) => ({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          })),
        }),
      })
      continue
    }
    for (const block of blocks)
      if (block.type === 'tool_result')
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: blockText(block.content),
        })
    const text = blockText(blocks)
    if (text) messages.push({ role: 'user', content: text })
  }
  return {
    model: body.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: body.max_tokens,
    messages,
    chat_template_kwargs: { enable_thinking: false },
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.stop_sequences && { stop: body.stop_sequences }),
    ...(body.tools && {
      tools: body.tools.map((tool: any) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      })),
    }),
  }
}

/**
 * An OpenAI chat stream as Messages events: text streams as it arrives, tool calls are sent whole
 * once the stream ends (the agent only runs them after the step), then the stop reason and usage.
 */
export function chatToMessages(body: NonNullable<Response['body']>) {
  const usage = { input_tokens: 0, output_tokens: 0 }
  const calls = new Map<number, { id: string; name: string; args: string }>()
  let started = false
  let text = -1 // index of the open text block
  let next = 0
  let stop = 'end_turn'
  let rest = ''
  const send = (
    controller: TransformStreamDefaultController<string>,
    event: { type: string; [key: string]: unknown },
  ) => controller.enqueue(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  const handle = (controller: TransformStreamDefaultController<string>, line: string) => {
    const data = line.startsWith('data:') ? line.slice(5).trim() : ''
    if (!data || data === '[DONE]') return
    const chunk = JSON.parse(data)
    if (!started) {
      started = true
      const message = { id: chunk.id ?? 'campus', type: 'message', role: 'assistant', content: [] }
      send(controller, {
        type: 'message_start',
        message: { ...message, model: chunk.model, usage },
      })
    }
    if (chunk.error)
      return send(controller, {
        type: 'error',
        error: { type: 'api_error', message: String(chunk.error.message ?? chunk.error) },
      })
    if (chunk.usage) {
      usage.input_tokens = chunk.usage.prompt_tokens ?? 0
      usage.output_tokens = chunk.usage.completion_tokens ?? 0
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      if (delta.content) {
        if (text < 0) {
          text = next++
          send(controller, {
            type: 'content_block_start',
            index: text,
            content_block: { type: 'text', text: '' },
          })
        }
        send(controller, {
          type: 'content_block_delta',
          index: text,
          delta: { type: 'text_delta', text: delta.content },
        })
      }
      for (const call of delta.tool_calls ?? []) {
        const entry = calls.get(call.index) ?? { id: '', name: '', args: '' }
        entry.id ||= call.id ?? ''
        entry.name ||= call.function?.name ?? ''
        entry.args += call.function?.arguments ?? ''
        calls.set(call.index, entry)
      }
      if (choice.finish_reason === 'length') stop = 'max_tokens'
    }
  }
  return body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          const lines = (rest + chunk).split('\n')
          rest = lines.pop()!
          for (const line of lines) handle(controller, line)
        },
        flush(controller) {
          handle(controller, rest)
          if (!started) return // nothing arrived; the adapter reports the closed stream
          if (text >= 0) send(controller, { type: 'content_block_stop', index: text })
          for (const { id, name, args } of calls.values()) {
            const index = next++
            const content_block = { type: 'tool_use', id: id || `call_${index}`, name, input: {} }
            send(controller, { type: 'content_block_start', index, content_block })
            if (args)
              send(controller, {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: args },
              })
            send(controller, { type: 'content_block_stop', index })
          }
          if (calls.size && stop !== 'max_tokens') stop = 'tool_use'
          send(controller, {
            type: 'message_delta',
            delta: { stop_reason: stop, stop_sequence: null },
            usage,
          })
          send(controller, { type: 'message_stop' })
        },
      }),
    )
    .pipeThrough(new TextEncoderStream())
}

export function campusFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (
      !url.startsWith(connection({ provider: 'campus', model: '' }).baseURL + '/') ||
      !url.endsWith('/messages') ||
      typeof init?.body !== 'string'
    )
      return inner(input, init)
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${headers.get('x-api-key') ?? ''}`)
    headers.delete('x-api-key')
    const response = await inner(url.replace(/\/messages$/, '/chat/completions'), {
      ...init,
      headers,
      body: JSON.stringify(toChatRequest(JSON.parse(init.body))),
    })
    if (!response.ok || !response.body) return response
    return new Response(chatToMessages(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
}
globalThis.fetch = campusFetch(globalThis.fetch)

/** 校内模型的看图能力未验证，按纯文本接入；其他供应商的模型均按可看图声明。 */
export const acceptsImages = (provider: string) => provider !== 'campus'
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
          inputModalities: acceptsImages(provider) ? ['text', 'image'] : ['text'],
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
