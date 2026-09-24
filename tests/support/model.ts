/** Test-only provider. Never imported by the production entry point. */
import {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

export function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '测试适配器：检查请求内容。' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'reasoning', text: '测试适配器：检查请求内容。' },
    },
    { type: 'block-start', index: 1, blockType: 'text' },
    ...Array.from(text, (char) => ({ type: 'text-delta' as const, index: 1, text: char })),
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolChunks(name: string, args: object): StreamChunk[] {
  const id = ToolCallId(randomUUID())
  const value = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: value },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: value } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export class TestModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  respond: (request: GenerateOptions) => StreamChunk[] | 'hang'
  constructor(respond?: (request: GenerateOptions) => StreamChunk[] | 'hang') {
    super()
    this.respond =
      respond ??
      ((request) => {
        const last = request.messages.at(-1)
        if (last?.role === 'tool') return textChunks('文件已生成，请从下方文件卡片下载。')
        const question =
          last?.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('') ??
          ''
        if (question.includes('持续生成')) return 'hang'
        if (question.includes('模拟失败')) throw new Error('Test provider failure')
        if (question.includes('生成报告'))
          return [
            ...textChunks('先生成报告。').filter((chunk) => chunk.type !== 'finish'),
            ...toolChunks('create_file', {
              name: '研究报告',
              format: 'docx',
              content: '# 研究报告\n自动化测试文档。',
            }).map((chunk) => ('index' in chunk ? { ...chunk, index: 2 } : chunk)),
          ]
        return textChunks(
          '## 测试回答\n\n这是**自动化测试**结果。\n\n- 第一项\n- 第二项\n\n[来源](https://example.org)\n\n<script>alert(1)</script>\n\n[无效链接](javascript:alert(1))',
        )
      })
  }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const response = this.respond(request)
    if (response === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '已经生成的部分内容' }
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error('Test stream aborted'))
        if (request.signal?.aborted) abort()
        else request.signal?.addEventListener('abort', abort, { once: true })
      })
    } else
      for (const chunk of response) {
        request.signal?.throwIfAborted()
        yield chunk
      }
  }
}
