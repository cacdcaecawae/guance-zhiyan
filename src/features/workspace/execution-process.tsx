import {
  AppWindowIcon,
  AtomIcon,
  BookOpenIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleStopIcon,
  FilePlusIcon,
  FileTextIcon,
  GlobeIcon,
  Loader2Icon,
  PencilIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { SlipsMark } from '@/app/logo'
import type { AnswerPart, AssistantMessage } from '@/types'
import { citationOrder } from './citations'
import { Markdown } from './markdown'
import { Reasoning } from './reasoning'

import {
  processItems,
  splitAnswer,
  toolNames,
  toolSummary,
  type Activity,
  type ProcessItem,
} from './tool-display'

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

const activityIcons: Record<Activity, LucideIcon> = {
  thinking: AtomIcon,
  read: FileTextIcon,
  write: PencilIcon,
  edit: PencilIcon,
  commands: TerminalIcon,
  webSearch: GlobeIcon,
  webFetch: AppWindowIcon,
  library: BookOpenIcon,
  file: FilePlusIcon,
  tools: WrenchIcon,
}

/**
 * 过程组，adapted from DSH ChatGroupSeat：组头是活动摘要，图标位悬停、聚焦或展开时换成箭头；
 * 正文初始收起，展开后最高 min(400px, 50vh)、组内滚动。
 */
function ProcessGroup({
  item,
  children,
}: {
  item: Extract<ProcessItem, { kind: 'group' }>
  children: ReactNode
}) {
  const Icon = activityIcons[item.activity]
  return (
    <details className="group/step min-w-0">
      <summary className="group/head flex w-fit max-w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-md py-1.5 text-ui-caption text-foreground-subtle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="relative size-3.5 shrink-0" aria-hidden>
          <Icon className="absolute inset-0 size-3.5 transition-opacity group-hover/head:opacity-0 group-focus-visible/head:opacity-0 group-open/step:opacity-0" />
          <ChevronDownIcon className="absolute inset-0 size-3.5 opacity-0 transition-opacity group-hover/head:opacity-100 group-focus-visible/head:opacity-100 group-open/step:rotate-180 group-open/step:opacity-100" />
        </span>
        <span className="min-w-0 truncate">{item.title}</span>
      </summary>
      <div className="flex max-h-[min(400px,50vh)] min-w-0 flex-col overflow-y-auto pb-1 pl-5.5">
        {children}
      </div>
    </details>
  )
}

/** Adapted from DSH's turn-process / final-answer boundary; see THIRD_PARTY_NOTICES. */
export function AnswerContent({ message }: { message: AssistantMessage }) {
  const { process, final } = splitAnswer(message)
  const loading = message.status === 'loading'
  // 同 DSH：只有正常完成的轮次能收起整轮，完成后默认收起；进行中、停止和失败时过程始终展开
  const collapsible = message.status === 'done' && process.length > 0
  const [chosen, setChosen] = useState<boolean>()
  // 收起整轮时换新 key，组、思考与工具的开合一并复位（同 DSH）
  const [resets, setResets] = useState(0)
  // 自动收起若会藏起键盘焦点，则保持展开（同 DSH）
  const [focused, setFocused] = useState(false)
  const [status, setStatus] = useState(message.status)
  if (status !== message.status) {
    setStatus(message.status)
    if (message.status === 'done' && focused) setChosen(true)
  }
  const open = !collapsible || (chosen ?? false)
  // One numbering for the whole answer: the same passage keeps its number across steps.
  const citations = citationOrder(
    message.parts.flatMap((part) => (part.type === 'tool' ? [] : [part.text])),
  )
  const renderPart = (part: AnswerPart) =>
    part.type === 'tool' ? (
      <ToolRow key={part.id} part={part} />
    ) : part.type === 'reasoning' ? (
      <div key={part.id}>
        <Reasoning
          text={part.text}
          running={loading && part === message.parts.at(-1)}
          citations={citations}
        />
      </div>
    ) : (
      // 阶段回复与最终回答同样排版（同 DSH），只是随过程收起
      <div key={part.id} className="py-1 font-serif text-ui-prose">
        <Markdown text={part.text} citations={citations} />
      </div>
    )
  // 整轮控件：同 DSH 是唯一的轮次级运行指示，生成中在用时前放竹简依次抽出
  const control = (
    <>
      {loading && <SlipsMark size={20} loading />}
      <span className="min-w-0 truncate">
        <ProcessLabel message={message} />
      </span>
      {collapsible && (
        <ChevronDownIcon className="size-3 shrink-0 group-open/process:rotate-180" aria-hidden />
      )}
    </>
  )
  const controlClass =
    'flex w-fit max-w-full min-w-0 list-none items-center gap-1.5 rounded-md py-1 text-ui-caption text-foreground-subtlest outline-none [&::-webkit-details-marker]:hidden'
  return (
    <>
      {loading && (
        <span role="status" className="sr-only">
          正在生成
        </span>
      )}
      {!process.length ? (
        // 没有过程内容时只是一行文字，不能展开（同 DSH）
        <p className={controlClass}>{control}</p>
      ) : (
        <details
          open={open}
          onToggle={(event) => {
            // 状态变化带来的自动开合不算用户选择：此时 toggle 的值与本次渲染的 open 相同
            const next = event.currentTarget.open
            if (!collapsible || next === open) return
            setChosen(next)
            if (!next) setResets((n) => n + 1)
          }}
          className="group/process min-w-0"
        >
          <summary
            tabIndex={collapsible ? undefined : -1}
            aria-disabled={!collapsible || undefined}
            onClick={collapsible ? undefined : (event) => event.preventDefault()}
            className={`${controlClass} ${collapsible ? 'cursor-pointer transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring' : 'cursor-default'}`}
          >
            {control}
          </summary>
          {/* 过程像页边批注：左侧细线，与最终回答区分主次 */}
          <div
            key={resets}
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
            }}
            className="mt-1 ml-1.5 flex min-w-0 flex-col border-l border-border pl-4"
          >
            {processItems(process, !loading || final.length > 0).map((item) =>
              item.kind === 'reply' ? (
                renderPart(item.part)
              ) : (
                <ProcessGroup key={item.key} item={item}>
                  {item.parts.map(renderPart)}
                </ProcessGroup>
              ),
            )}
          </div>
        </details>
      )}
      {final.map(renderPart)}
    </>
  )
}
