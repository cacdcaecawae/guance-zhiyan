import {
  ArrowDownIcon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  DownloadIcon,
  PaperclipIcon,
  RotateCcwIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { artifactUrl, imageUrl } from '@/services/research'
import type { Artifact, AssistantMessage, Message } from '@/types'
import { AnswerContent } from './execution-process'
import { FormatBlock } from './file-preview'
import { splitAnswer } from './tool-display'

/** 成功时输出所生成文件 JSON 的工具，据此把文件归到生成它的那一轮 */
const FILE_TOOLS = new Set(['create_file', 'export_file'])

type Preview = { previewId?: string | null; onPreview?: (id: string) => void }

/** 文件卡片：朱红格式块 + 文件名，整卡可点开预览，与正文明显区分 */
function FileCards({ files, previewId, onPreview }: { files: Artifact[] } & Preview) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
      {files.map((file) => (
        <li
          key={file.id}
          className={`relative flex min-w-0 items-center gap-3 rounded-xl border p-3 transition-colors has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-ring ${previewId === file.id ? 'border-brand bg-accent' : 'border-card-border bg-card hover:border-border-hover hover:bg-surface-hover'}`}
        >
          <FormatBlock format={file.format} />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              id={`artifact-${file.id}`}
              aria-pressed={previewId === file.id}
              onClick={() => onPreview?.(file.id)}
              className="block max-w-full truncate rounded-sm text-left text-ui-base font-medium outline-none after:absolute after:inset-0 after:rounded-xl"
            >
              {file.name}
            </button>
            <p className="text-ui-sm text-foreground-subtlest">
              {Math.ceil(file.size / 1024)} KB
              {previewId === file.id && ' · 预览中'}
            </p>
          </div>
          <a
            href={artifactUrl(file)}
            aria-label={`下载 ${file.name}`}
            title="下载"
            className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-md text-foreground-subtle outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <DownloadIcon className="size-4" />
          </a>
        </li>
      ))}
    </ul>
  )
}

/** 复制最终回答的 Markdown 原文；剪贴板只在 HTTPS 或本机可用，失败时明确提示。 */
function CopyAnswer({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = () => {
    const done = (next: 'copied' | 'failed') => {
      setState(next)
      clearTimeout(timer.current)
      if (next === 'copied') timer.current = setTimeout(() => setState('idle'), 2000)
    }
    if (!navigator.clipboard) return done('failed')
    navigator.clipboard.writeText(text).then(
      () => done('copied'),
      () => done('failed'),
    )
  }
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="复制回答"
        title="复制回答"
        onClick={copy}
        className="rounded-md"
      >
        {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
      </Button>
      <span
        aria-live="polite"
        className={`text-ui-sm ${state === 'failed' ? 'text-destructive' : 'text-foreground-subtlest'}`}
      >
        {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : ''}
      </span>
    </>
  )
}

export function MessageList({
  sessionId,
  messages,
  busy,
  onRetry,
  artifacts = [],
  previewId,
  onPreview,
}: {
  sessionId: string
  messages: Message[]
  busy: boolean
  onRetry: (message: AssistantMessage) => void
  /** 会话文件：显示在生成它的那一轮回答下，归不到任何一轮的放在列表末尾 */
  artifacts?: Artifact[]
} & Preview) {
  const end = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [away, setAway] = useState(false)
  // 文件 id 对应生成它的回答；重新生成前旧尝试留下的文件、解析不出 id 的输出都不归属任何一轮
  const owner = new Map<string, string>()
  for (const message of messages)
    if (message.role === 'assistant')
      for (const part of message.parts)
        if (part.type === 'tool' && FILE_TOOLS.has(part.name) && part.status === 'done')
          try {
            owner.set(JSON.parse(part.output).id, message.id)
          } catch {
            // 输出不是文件 JSON，跳过
          }
  const cards = (files: Artifact[]) =>
    files.length > 0 && <FileCards files={files} previewId={previewId} onPreview={onPreview} />
  const unclaimed = artifacts.filter((file) => !owner.has(file.id))
  // 未归属的文件卡片排在列表之后、同一滚动容器内，所以滚到容器底部而不是列表末尾。
  const scrollToBottom = () => {
    const scroller = end.current?.closest('[data-message-scroll]')
    scroller?.scrollTo({ top: scroller.scrollHeight })
  }
  useEffect(() => {
    const scroller = end.current?.closest('[data-message-scroll]')
    if (!scroller) return
    const onScroll = () => {
      follow.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
      setAway(!follow.current)
    }
    scroller.addEventListener('scroll', onScroll)
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    if (follow.current) scrollToBottom()
  }, [messages])
  return (
    <div className="mx-auto w-full max-w-[52rem] py-8">
      <ol className="flex flex-col">
        {messages.map((message) =>
          message.role === 'user' ? (
            // 参照 Claude：问题靠右、浅灰圆角气泡，附图排在气泡上方；回答靠左、无外框。
            <li key={message.id} className="mt-10 flex flex-col items-end gap-2 first:mt-0">
              {message.images && (
                <ul aria-label="问题附图" className="flex max-w-[85%] flex-wrap justify-end gap-2">
                  {message.images.map((image, index) => (
                    <li key={index}>
                      <a
                        href={imageUrl(sessionId, image)}
                        target="_blank"
                        rel="noreferrer"
                        title="在新标签页查看原图"
                        className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {/* 宽高属性先占位，图片加载后列表高度不跳；过窄的长图（如手机长截图）至少 96px 宽，裁切显示顶部 */}
                        <img
                          src={imageUrl(sessionId, image)}
                          alt={image.name || '图片'}
                          width={image.width}
                          height={image.height}
                          loading="lazy"
                          className="h-40 w-auto max-w-full min-w-24 rounded-xl border border-card-border bg-card object-cover object-top"
                        />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {message.text && (
                <p className="max-w-[85%] rounded-2xl bg-tag px-4 py-2.5 text-ui-base whitespace-pre-wrap wrap-anywhere">
                  <span className="sr-only">问题：</span>
                  {message.text}
                </p>
              )}
            </li>
          ) : (
            <li key={message.id} className="mt-6">
              <AnswerArticle
                message={message}
                busy={busy}
                onRetry={onRetry}
                latest={message === messages.at(-1)}
                files={cards(artifacts.filter((file) => owner.get(file.id) === message.id))}
              />
            </li>
          ),
        )}
      </ol>
      {unclaimed.length > 0 && (
        <section aria-label="会话文件" className="mt-10">
          <h2 className="mb-3 flex items-center gap-2 font-serif text-ui-base font-semibold">
            <PaperclipIcon className="size-4 text-foreground-subtlest" aria-hidden />
            会话文件
            <span className="font-sans text-ui-sm font-normal text-foreground-subtlest">
              {unclaimed.length} 个
            </span>
          </h2>
          {cards(unclaimed)}
        </section>
      )}
      <div ref={end} tabIndex={-1} className="outline-none" />
      {away && (
        <div className="pointer-events-none sticky bottom-3 flex justify-center">
          <Button
            variant="outline"
            size="icon"
            aria-label="回到底部"
            title="回到底部"
            className="pointer-events-auto rounded-full bg-popover shadow-md"
            onClick={() => {
              scrollToBottom()
              // 按钮随即消失，焦点移到列表末尾，而不是掉回页面开头
              end.current?.focus({ preventScroll: true })
            }}
          >
            <ArrowDownIcon />
          </Button>
        </div>
      )}
    </div>
  )
}

function AnswerArticle({
  message,
  busy,
  onRetry,
  latest,
  files,
}: {
  message: AssistantMessage
  busy: boolean
  latest: boolean
  onRetry: (message: AssistantMessage) => void
  /** 本轮生成的文件卡片，排在回答正文之后 */
  files: ReactNode
}) {
  // 只去掉开头空行与末尾空白，保留开头缩进（如缩进代码块），复制出的 Markdown 含义不变
  const joined = splitAnswer(message)
    .final.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n')
  const finalText = joined.trim() ? joined.replace(/^\s*\n/, '').trimEnd() : ''
  const retry = latest && (message.status === 'error' || message.status === 'stopped')
  return (
    <article aria-label="回答" tabIndex={-1} className="flex min-w-0 flex-col gap-2 outline-none">
      <AnswerContent message={message} />
      {files}
      {message.status === 'stopped' && (
        <p role="status" className="text-ui-caption text-foreground-subtle">
          {message.error ?? '已停止'}
        </p>
      )}
      {message.status === 'error' && (
        <p role="alert" className="flex items-start gap-1.5 text-ui-caption text-destructive">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {message.error}
        </p>
      )}
      {message.status === 'done' &&
        !message.parts
          .slice(message.parts.findLastIndex((part) => part.type === 'tool') + 1)
          .some((part) => part.type === 'text' && part.text.trim()) && (
          <p className="text-ui-caption text-foreground-subtle">本次未返回正文。</p>
        )}
      {message.status !== 'loading' && (finalText || retry) && (
        <div className="-ml-1.5 flex min-h-7 items-center gap-0.5 text-foreground-subtlest">
          {finalText && <CopyAnswer text={finalText} />}
          {retry && (
            <Button
              variant="outline"
              size="sm"
              aria-disabled={busy}
              onClick={(event) => {
                if (busy) return
                event.currentTarget.closest('article')?.focus({ preventScroll: true })
                onRetry(message)
              }}
              className="ml-1 rounded-md text-foreground first:ml-1.5"
            >
              <RotateCcwIcon className="size-3.5" />
              重新生成
            </Button>
          )}
          {message.endedAt !== undefined && (
            <time
              dateTime={new Date(message.endedAt).toISOString()}
              className="ml-1.5 text-ui-sm tabular-nums"
            >
              {clock(message.endedAt)}
            </time>
          )}
        </div>
      )}
    </article>
  )
}

/** 回答的结束时刻，同 DSH message-chrome：当天只写时分，今年加月日，往年加年月日。 */
function clock(time: number) {
  const date = new Date(time)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === now.toDateString()) return hm
  const md = `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}年${md}`} ${hm}`
}
