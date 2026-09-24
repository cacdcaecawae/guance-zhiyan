import {
  ChevronDownIcon,
  CircleAlertIcon,
  FileTextIcon,
  GlobeIcon,
  Loader2Icon,
  WrenchIcon,
} from 'lucide-react'
import type { AnswerPart, AssistantMessage } from '@/types'
import { Markdown } from './markdown'
import { Reasoning } from './reasoning'

import { splitAnswer, toolNames, toolSummary } from './tool-display'

const statusText = { running: '执行中', done: '已完成', error: '失败 / 已中断' }

export function ToolRow({ part }: { part: Extract<AnswerPart, { type: 'tool' }> }) {
  // 状态放在图标位：执行中转圈、失败为警示图标；文字对读屏保留，执行中另外可见。
  const Icon =
    part.status === 'running'
      ? Loader2Icon
      : part.status === 'error'
        ? CircleAlertIcon
        : part.name.startsWith('web_')
          ? GlobeIcon
          : part.name.includes('file')
            ? FileTextIcon
            : WrenchIcon
  return (
    <details className="group/tool min-w-0 text-foreground-subtle">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md py-1.5 text-ui-caption outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Icon
          className={`size-3.5 shrink-0 ${part.status === 'running' ? 'animate-spin' : ''} ${part.status === 'error' ? 'text-destructive' : ''}`}
          aria-hidden
        />
        <span className="shrink-0">{toolNames[part.name] ?? part.name}</span>
        <span className="min-w-0 flex-1 truncate text-foreground-subtlest">
          {toolSummary(part.input)}
        </span>
        <span
          className={
            part.status === 'running' ? 'shrink-0 text-ui-sm text-foreground-subtlest' : 'sr-only'
          }
        >
          {statusText[part.status]}
        </span>
        <ChevronDownIcon
          className="size-3 shrink-0 text-foreground-subtlest group-open/tool:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="mb-2 ml-5 min-w-0 rounded-md bg-surface-hover p-3 text-ui-caption">
        <p className="mb-1 text-ui-sm font-medium text-foreground-subtle">调用参数</p>
        <pre className="max-h-48 overflow-auto font-mono text-ui-sm whitespace-pre-wrap text-foreground wrap-anywhere">
          {part.input}
        </pre>
        {part.output && (
          <>
            <p className="mt-3 mb-1 text-ui-sm font-medium text-foreground-subtle">执行结果</p>
            <pre className="max-h-72 overflow-auto font-mono text-ui-sm whitespace-pre-wrap text-foreground wrap-anywhere">
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
  const { process, final } = splitAnswer(message)
  const tools = process.filter((part) => part.type === 'tool').length
  const messages = new Set(process.flatMap((part) => (part.type === 'text' ? [part.step] : [])))
    .size
  const failed = process.filter((part) => part.type === 'tool' && part.status === 'error').length
  const summary =
    [tools && `${tools} 次工具调用`, messages && `${messages} 条消息`]
      .filter(Boolean)
      .join(' · ') || '执行过程'
  const renderPart = (part: AnswerPart, inProcess: boolean) =>
    part.type === 'tool' ? (
      <ToolRow key={part.id} part={part} />
    ) : part.type === 'reasoning' ? (
      // 最终一步的思考不在可收起的过程内，但同样按页边批注排列
      <div key={part.id} className={inProcess ? undefined : 'ml-1.5 border-l border-border pl-4'}>
        <Reasoning
          text={part.text}
          running={message.status === 'loading' && part === message.parts.at(-1)}
        />
      </div>
    ) : (
      <div
        key={part.id}
        className={inProcess ? 'py-1 text-ui-caption text-foreground-subtle' : 'py-1 text-ui-prose'}
      >
        <Markdown text={part.text} />
      </div>
    )
  return (
    <>
      {!!process.length && (
        <details open className="group/process min-w-0">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-ui-sm text-foreground-subtlest outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span>{summary}</span>
            {!!failed && <span className="text-destructive">· {failed} 次失败</span>}
            <ChevronDownIcon className="size-3 group-open/process:rotate-180" aria-hidden />
          </summary>
          {/* 过程像页边批注：左侧细线，与最终回答区分主次 */}
          <div className="mt-1 ml-1.5 flex min-w-0 flex-col border-l border-border pl-4">
            {process.map((part) => renderPart(part, true))}
          </div>
        </details>
      )}
      {final.map((part) => renderPart(part, false))}
    </>
  )
}
