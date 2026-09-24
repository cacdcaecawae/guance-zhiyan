import { ChevronDownIcon, FileTextIcon, GlobeIcon, Loader2Icon, WrenchIcon } from 'lucide-react'
import type { AnswerPart, AssistantMessage } from '@/types'
import { Markdown } from './markdown'
import { Reasoning } from './reasoning'

import { toolNames, toolSummary } from './tool-display'

export function ToolRow({ part }: { part: Extract<AnswerPart, { type: 'tool' }> }) {
  const Icon =
    part.status === 'running'
      ? Loader2Icon
      : part.name.startsWith('web_')
        ? GlobeIcon
        : part.name.includes('file')
          ? FileTextIcon
          : WrenchIcon
  return (
    <details className="group/tool min-w-0 text-foreground-subtle">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md py-2 text-ui-caption outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Icon
          className={`size-3.5 shrink-0 ${part.status === 'running' ? 'animate-spin' : ''}`}
          aria-hidden
        />
        <span className="shrink-0">{toolNames[part.name] ?? part.name}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 flex-1 truncate text-ui-sm">{toolSummary(part.input)}</span>
        <span
          className={`shrink-0 text-ui-sm ${part.status === 'error' ? 'text-destructive' : ''}`}
        >
          {part.status === 'running'
            ? '执行中'
            : part.status === 'done'
              ? '已完成'
              : '失败 / 已中断'}
        </span>
        <ChevronDownIcon className="size-3 shrink-0 group-open/tool:rotate-180" aria-hidden />
      </summary>
      <div className="mb-2 ml-5 min-w-0 rounded-md bg-surface-hover p-3 text-ui-sm">
        <p className="mb-1 font-medium">调用参数</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap wrap-anywhere">{part.input}</pre>
        {part.output && (
          <>
            <p className="mt-3 mb-1 font-medium">执行结果</p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap wrap-anywhere">
              {part.output}
            </pre>
          </>
        )}
      </div>
    </details>
  )
}

/** Adapted from DSH's turn-process / final-answer boundary; see THIRD_PARTY_NOTICES. */
export function AnswerContent({ message }: { message: AssistantMessage }) {
  const lastTool = message.parts.findLastIndex((part) => part.type === 'tool')
  const lastText = message.parts.findLast((part) => part.type === 'text')
  const finalStart =
    lastText && message.parts.indexOf(lastText) > lastTool
      ? message.parts.findIndex((part) => part.type !== 'tool' && part.step === lastText.step)
      : message.parts.length
  const process = message.parts.slice(0, finalStart)
  const final = message.parts.slice(finalStart)
  const tools = process.filter((part) => part.type === 'tool').length
  const messages = new Set(process.flatMap((part) => (part.type === 'text' ? [part.step] : [])))
    .size
  const renderPart = (part: AnswerPart) =>
    part.type === 'tool' ? (
      <ToolRow key={part.id} part={part} />
    ) : part.type === 'reasoning' ? (
      <Reasoning
        key={part.id}
        text={part.text}
        running={message.status === 'loading' && part === message.parts.at(-1)}
      />
    ) : (
      <div key={part.id} className="py-2">
        <Markdown text={part.text} />
      </div>
    )
  return (
    <>
      {!!process.length && (
        <details open className="group/process min-w-0">
          <summary className="flex cursor-pointer list-none items-center gap-2 border-b border-border pb-2 text-ui-caption text-foreground-subtle outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span>
              {tools} 次工具调用 · {messages} 条消息
            </span>
            <ChevronDownIcon className="size-3.5 group-open/process:rotate-180" aria-hidden />
          </summary>
          <div className="flex min-w-0 flex-col gap-1 pt-3">{process.map(renderPart)}</div>
        </details>
      )}
      {final.map(renderPart)}
    </>
  )
}
