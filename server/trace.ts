import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assembleAssistantStream, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TraceEntry } from '../src/types/index.ts'
import type { LiveAttempt } from './view.ts'
import { toolError } from './view.ts'

const contentText = (content: readonly ContentBlock[]) =>
  content
    .flatMap((block) => (block.type === 'text' || block.type === 'reasoning' ? [block.text] : []))
    .join('\n\n')
/** Project visible event content only: never expose request headers, signatures or tool metadata. */
export function traceFromEvents(
  events: readonly SessionEvent[],
  running: boolean,
  live?: LiveAttempt,
): TraceEntry[] {
  const rows: TraceEntry[] = []
  const users = new Set<string>()
  const attempts = new Set<string>()
  let turn = 0
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    else if (event.type === 'system/message' || event.type === 'developer/message') {
      const text = contentText(event.data.message.content)
      if (text)
        rows.push({
          id: `event-${event.seq}`,
          turn: event.data.turn,
          step: event.data.step,
          kind: event.type === 'system/message' ? 'system' : 'context',
          label: event.type === 'system/message' ? '系统提示词' : '上下文注入',
          text,
          time: event.time,
        })
    } else if (event.type === 'user/message' || event.type === 'agent/inbox/spliced') {
      const messages = event.type === 'user/message' ? [event.data] : event.data.inserted
      for (const message of messages) {
        if (
          event.type === 'agent/inbox/spliced' &&
          events.some((item) => item.type === 'user/message' && item.data.id === message.id)
        )
          continue
        if (users.has(message.id)) continue
        users.add(message.id)
        rows.push({
          id: message.id,
          turn,
          kind: message.source.kind === 'user' ? 'user' : 'context',
          label: message.source.kind === 'user' ? '用户' : '上下文注入',
          text: contentText(message.content),
          time: event.time,
        })
      }
    } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      if (event.type === 'assistant/attempt') attempts.add(`event-${event.seq}`)
      const start = events.find(
        (item) =>
          item.type === 'step/start' &&
          item.data.turn === event.data.turn &&
          item.data.step === event.data.step,
      )
      rows.push({
        id: `event-${event.seq}`,
        turn: event.data.turn,
        step: event.data.step,
        kind: 'assistant',
        label: '助手',
        text: contentText(
          event.type === 'assistant/message'
            ? event.data.message.content
            : assembleAssistantStream(event.data.stream).interruptedBlocks(),
        ),
        time: start?.time ?? event.time,
        end: event.time,
        status:
          event.type === 'assistant/attempt'
            ? 'error'
            : event.data.interrupted
              ? 'stopped'
              : 'done',
      })
    } else if (event.type === 'tool/call') {
      rows.push({
        id: event.data.callId,
        turn: event.data.turn,
        step: event.data.step,
        kind: 'tool',
        label: event.data.name,
        input: event.data.arguments,
        text: '',
        time: event.time,
        status: 'running',
      })
    } else if (event.type === 'tool/result') {
      const row = rows.find((item) => item.id === event.data.message.toolCallId)
      if (row) {
        row.end = event.time
        row.status = event.data.message.isError ? 'error' : 'done'
        row.text = event.data.message.isError
          ? toolError(event.data.error?.code)
          : contentText(event.data.message.content)
      }
    } else if (event.type === 'turn/end') {
      const lastModel = rows.findLast(
        (row) => row.turn === event.data.turn && row.kind === 'assistant',
      )
      if (
        lastModel &&
        attempts.has(lastModel.id) &&
        (event.data.reason.kind === 'aborted' || event.data.reason.kind === 'interrupted')
      )
        lastModel.status = 'stopped'
      for (const row of rows)
        if (row.turn === event.data.turn && row.status === 'running') {
          row.end = event.time
          row.status = 'stopped'
        }
    }
  }
  if (
    live &&
    !events.some(
      (event) =>
        (event.type === 'assistant/message' || event.type === 'assistant/attempt') &&
        event.data.turn === live.turn &&
        event.data.step === live.step,
    )
  ) {
    const start = events.find(
      (event) =>
        event.type === 'step/start' &&
        event.data.turn === live.turn &&
        event.data.step === live.step,
    )
    if (start)
      rows.push({
        id: `live-${live.turn}-${live.step}`,
        turn: live.turn,
        step: live.step,
        kind: 'assistant',
        label: '助手',
        text: live.chunks
          .flatMap((chunk) =>
            chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? [chunk.text] : [],
          )
          .join(''),
        time: start.time,
        status: running ? 'running' : 'stopped',
      })
  }
  if (!running) for (const row of rows) if (row.status === 'running') row.status = 'stopped'
  return rows
}
