import {
  ArrowDownIcon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  Loader2Icon,
  RotateCcwIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssistantMessage, Message } from '@/types'
import { AnswerContent } from './execution-process'
import { splitAnswer } from './tool-display'

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
        {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败，请手动选择文本' : ''}
      </span>
    </>
  )
}

export function MessageList({
  messages,
  busy,
  onRetry,
}: {
  messages: Message[]
  busy: boolean
  onRetry: (message: AssistantMessage) => void
}) {
  const end = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [away, setAway] = useState(false)
  // 会话文件卡片排在列表之后、同一滚动容器内，所以滚到容器底部而不是列表末尾。
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
    <div className="mx-auto w-full max-w-4xl py-8">
      <ol className="flex flex-col">
        {messages.map((message) =>
          message.role === 'user' ? (
            // 每一问以朱红“问”字印章起头、衬线粗体；轮次之间细线分隔，回答缩进到印章之后。
            <li
              key={message.id}
              className="mt-8 flex items-start gap-3 border-t border-border pt-8 first:mt-0 first:border-t-0 first:pt-0"
            >
              <span
                aria-hidden
                className="mt-0.5 flex size-6.5 shrink-0 items-center justify-center rounded-sm bg-seal font-serif text-ui-caption font-bold text-seal-foreground"
              >
                问
              </span>
              <p className="min-w-0 font-serif text-ui-lg leading-relaxed font-bold whitespace-pre-wrap">
                <span className="sr-only">问题：</span>
                {message.text}
              </p>
            </li>
          ) : (
            <li key={message.id} className="mt-2 pl-9.5">
              <AnswerArticle message={message} busy={busy} onRetry={onRetry} />
            </li>
          ),
        )}
      </ol>
      <div ref={end} />
      {away && (
        <div className="pointer-events-none sticky bottom-3 flex justify-center">
          <Button
            variant="outline"
            size="icon"
            aria-label="回到底部"
            title="回到底部"
            className="pointer-events-auto rounded-full bg-popover shadow-md"
            onClick={scrollToBottom}
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
}: {
  message: AssistantMessage
  busy: boolean
  onRetry: (message: AssistantMessage) => void
}) {
  const finalText = splitAnswer(message)
    .final.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n')
    .trim()
  const retry = message.status === 'error' || message.status === 'stopped'
  return (
    <article aria-label="回答" className="flex min-w-0 flex-col gap-2">
      <AnswerContent message={message} />
      {message.status === 'loading' && (
        <div role="status" className="flex items-center gap-2 text-ui-caption text-brand">
          <Loader2Icon className="size-4 animate-spin" aria-hidden />
          正在生成…
        </div>
      )}
      {message.status === 'stopped' && (
        <p role="status" className="text-ui-caption text-foreground-subtle">
          {message.error ?? '已停止，已生成的内容已保留。'}
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
              variant="ghost"
              size="icon-sm"
              aria-label="重新提问"
              title="重新提问"
              disabled={busy}
              onClick={() => onRetry(message)}
              className="rounded-md"
            >
              <RotateCcwIcon />
            </Button>
          )}
        </div>
      )}
    </article>
  )
}
