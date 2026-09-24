import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expandAssistantStream, type StreamChunk, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AnswerPart, AssistantMessage, Message } from '../src/types/index.ts'

export interface LiveAttempt {
  turn: number
  step: number
  chunks: StreamChunk[]
}
const textOf = (content: readonly ContentBlock[]) =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

export function toolError(code?: string): string {
  const messages: Record<string, string> = {
    SANDBOX_UNAVAILABLE: '执行环境不可用，请检查沙箱服务后重试。',
    FS_NOT_FOUND: '工作区中没有找到该文件，请检查路径。',
    FS_PERMISSION_DENIED: '无法访问该文件，请使用当前会话工作区。',
    FS_TOO_LARGE: '文件超过本次操作支持的大小。',
    WEB_BLOCKED_URL:
      '网页地址被安全检查拦截。若公网域名被本机代理解析为虚拟 IP，请配置后端 HTTP_PROXY / HTTPS_PROXY 后重试。',
    WEB_FETCH_TIMEOUT: '网页读取超时，请重试或更换来源。',
    WEB_PROVIDER_ERROR: '搜索供应商未返回有效结果，请检查平台搜索支持与后端配置后重试。',
    WEB_PROVIDER_CREDENTIAL_MISSING: '搜索供应商密钥未配置，请在后端配置后重试。',
    WEB_UNSUPPORTED_CONTENT_TYPE: '该地址返回的文件类型暂不支持网页读取。',
  }
  return messages[code ?? ''] ?? '工具执行失败，请检查参数、网络或服务配置。'
}

function appendChunks(parts: AnswerPart[], chunks: StreamChunk[], prefix: string, step: number) {
  for (const chunk of chunks) {
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') continue
    const id = `${prefix}-${chunk.index}`
    const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
    const part = parts.find((p) => p.id === id)
    if (part && part.type !== 'tool') part.text += chunk.text
    else parts.push({ id, type, text: chunk.text, step })
  }
}

/** Only public message content crosses HTTP; internal headers and credentials never do. */
export function messagesFromEvents(
  events: readonly SessionEvent[],
  running: boolean,
  live?: LiveAttempt,
): Message[] {
  const messages: Message[] = []
  let answer: AssistantMessage | undefined
  let question = ''
  let turn = 0
  const userIds = new Set<string>()
  const addUser = (id: string, content: readonly ContentBlock[]) => {
    question = textOf(content)
    if (!userIds.has(id)) {
      messages.push({ id, role: 'user', text: question })
      userIds.add(id)
    }
    if (answer?.status === 'loading') answer.question = question
  }
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted)
        if (message.source.kind === 'user') addUser(message.id, message.content)
    } else if (event.type === 'user/message') {
      if (event.data.source.kind === 'user') addUser(event.data.id, event.data.content)
    } else if (event.type === 'turn/start') {
      turn = event.data.turn
      answer = { id: `turn-${turn}`, role: 'assistant', question, status: 'loading', parts: [] }
      messages.push(answer)
    } else if (
      answer &&
      (event.type === 'assistant/message' || event.type === 'assistant/attempt')
    ) {
      appendChunks(
        answer.parts,
        expandAssistantStream(event.data.stream).map((member) => member.chunk),
        `step-${event.data.step}-${event.seq}`,
        event.data.step,
      )
    } else if (answer && event.type === 'tool/call') {
      answer.parts.push({
        id: event.data.callId,
        type: 'tool',
        name: event.data.name,
        input: event.data.arguments.slice(0, 2000),
        output: '',
        status: 'running',
      })
    } else if (answer && event.type === 'tool/result') {
      const part = answer.parts.find(
        (p) => p.type === 'tool' && p.id === event.data.message.toolCallId,
      )
      if (part?.type === 'tool') {
        part.status = event.data.message.isError ? 'error' : 'done'
        part.output = event.data.message.isError
          ? toolError(event.data.error?.code)
          : textOf(event.data.message.content).slice(0, 16000)
      }
    } else if (answer && event.type === 'turn/end') {
      const reason = event.data.reason
      answer.status =
        reason.kind === 'completed'
          ? 'done'
          : reason.kind === 'aborted' || reason.kind === 'interrupted'
            ? 'stopped'
            : 'error'
      if (answer.status === 'error') {
        answer.error =
          reason.kind === 'max-tokens'
            ? '回答达到长度限制，尚未完成。可以继续提问。'
            : '回答生成失败，请检查模型配置后重试。'
      }
      if (reason.kind === 'aborted' && reason.reason.kind === 'hook')
        answer.error = reason.reason.reason
    }
  }
  if (
    answer &&
    live &&
    live.turn === turn &&
    !events.some(
      (e) =>
        (e.type === 'assistant/message' || e.type === 'assistant/attempt') &&
        e.data.turn === live.turn &&
        e.data.step === live.step,
    )
  ) {
    appendChunks(answer.parts, live.chunks, `live-${live.step}`, live.step)
  }
  for (const message of messages)
    if (message.role === 'assistant' && message.status === 'loading' && !running) {
      message.status = 'stopped'
      message.error = '上次生成已中断，可以重新提问。'
    }
  for (const message of messages)
    if (message.role === 'assistant' && message.status !== 'loading') {
      for (const part of message.parts)
        if (part.type === 'tool' && part.status === 'running') {
          part.status = 'error'
          part.output = '工具执行已中断。'
        }
    }
  return messages
}
