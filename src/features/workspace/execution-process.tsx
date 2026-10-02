import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleStopIcon,
  FileTextIcon,
  GlobeIcon,
  Loader2Icon,
  WrenchIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AnswerPart, AssistantMessage } from '@/types'
import { citationOrder } from './citations'
import { Markdown } from './markdown'
import { Reasoning } from './reasoning'

import { splitAnswer, toolNames, toolSummary } from './tool-display'

const statusText = { running: '执行中', done: '已完成', error: '失败', stopped: '已中断' }

export function ToolRow({ part }: { part: Extract<AnswerPart, { type: 'tool' }> }) {
  // 状态放在图标位：执行中转圈、失败为警示图标；文字对读屏保留，执行中另外可见。
  const Icon =
    part.status === 'running'
      ? Loader2Icon
      : part.status === 'error'
        ? CircleAlertIcon
        : part.status === 'stopped'
          ? CircleStopIcon
          : part.name.startsWith('web_')
            ? GlobeIcon
            : part.name.includes('file')
              ? FileTextIcon
              : WrenchIcon
  return (
    <details className="group/tool min-w-0 text-foreground-subtle">
      <summary className="flex w-fit max-w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-md py-1.5 text-ui-caption outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Icon
          className={`size-3.5 shrink-0 ${part.status === 'running' ? 'animate-spin' : ''} ${part.status === 'error' ? 'text-destructive' : ''}`}
          aria-hidden
        />
        <span className="shrink-0">{toolNames[part.name] ?? part.name}</span>
        <span className="min-w-0 truncate text-foreground-subtlest">{toolSummary(part.input)}</span>
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

/** 用时（同 DSH）：不满一分钟只写秒，满一分钟写分秒，满一小时写时分秒；进行中秒数不补零，以免跳动。 */
function formatDuration(ms: number, live: boolean) {
  const total = Math.floor(Math.max(1000, ms) / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = live ? String(total % 60) : pad(total % 60)
  if (hours) return `${hours}小时${pad(minutes)}分${seconds}秒`
  return minutes ? `${minutes}分${seconds}秒` : `${total}秒`
}

/**
 * 执行过程标题，adapted from DSH TurnProcessNodeView：进行中每秒更新用时，完成写用时，停止与失败直接写明。
 * 单独成组件，每秒只重绘这一行。用时以服务器记录的开始时间对照本机时钟，两边时钟不一致时进行中的用时会有偏差。
 */
function ProcessLabel({ message }: { message: AssistantMessage }) {
  const { status, startedAt, endedAt } = message
  const ticking = status === 'loading' && startedAt !== undefined
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  if (status === 'loading')
    return startedAt === undefined
      ? '进行中'
      : `进行中，用时 ${formatDuration(now - startedAt, true)}`
  // 停止与失败也带用时（DSH 只写状态）：回答下方另有一行写明停止或失败原因，避免两行重复
  const state = status === 'stopped' ? '已停止' : status === 'error' ? '处理失败' : '已完成'
  return startedAt === undefined || endedAt === undefined
    ? state
    : `${state}，用时 ${formatDuration(endedAt - startedAt, false)}`
}

/** Adapted from DSH's turn-process / final-answer boundary; see THIRD_PARTY_NOTICES. */
export function AnswerContent({ message }: { message: AssistantMessage }) {
  const { process, final } = splitAnswer(message)
  // 完成后默认折起，进行中、停止和失败时展开；用户手动展开或折起后以用户为准
  const [chosen, setChosen] = useState<boolean>()
  const open = chosen ?? message.status !== 'done'
  // One numbering for the whole answer: the same passage keeps its number across steps.
  const citations = citationOrder(
    message.parts.flatMap((part) => (part.type === 'tool' ? [] : [part.text])),
  )
  const renderPart = (part: AnswerPart, inProcess: boolean) =>
    part.type === 'tool' ? (
      <ToolRow key={part.id} part={part} />
    ) : part.type === 'reasoning' ? (
      <div key={part.id}>
        <Reasoning
          text={part.text}
          running={message.status === 'loading' && part === message.parts.at(-1)}
          citations={citations}
        />
      </div>
    ) : (
      <div
        key={part.id}
        className={
          inProcess
            ? 'py-1 text-ui-caption text-foreground-subtle'
            : 'py-1 font-serif text-ui-prose'
        }
      >
        <Markdown text={part.text} citations={citations} />
      </div>
    )
  return (
    <>
      {/* 同 DSH：每轮都写用时；没有过程内容时只是一行文字，不能展开 */}
      {!process.length && (
        <p className="py-1 text-ui-caption text-foreground-subtlest">
          <ProcessLabel message={message} />
        </p>
      )}
      {!!process.length && (
        <details
          open={open}
          // 只记录用户的操作：随状态自动展开或折起时，toggle 事件里的值与本次渲染的 open 相同
          onToggle={(event) => {
            if (event.currentTarget.open !== open) setChosen(event.currentTarget.open)
          }}
          className="group/process min-w-0"
        >
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-ui-caption text-foreground-subtlest outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span>
              <ProcessLabel message={message} />
            </span>
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
