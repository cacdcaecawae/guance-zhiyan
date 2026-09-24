import { Loader2Icon, RotateCcwIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import type { AssistantMessage, Message } from '@/types'
import { AnswerContent } from './execution-process'

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
  useEffect(() => {
    const scroller = end.current?.closest('[data-message-scroll]')
    if (!scroller) return
    const onScroll = () => {
      follow.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
    }
    scroller.addEventListener('scroll', onScroll)
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    if (follow.current) end.current?.scrollIntoView({ block: 'end' })
  }, [messages])
  return (
    <div className="mx-auto w-full max-w-3xl py-6">
      <ol className="flex flex-col gap-8">
        {messages.map((message) => (
          <li key={message.id} className={message.role === 'user' ? 'flex justify-end' : undefined}>
            {message.role === 'user' ? (
              <div className="max-w-[85%] rounded-xl bg-accent px-4 py-2 whitespace-pre-wrap">
                {message.text}
              </div>
            ) : (
              <article aria-label="回答" className="min-w-0 py-2">
                <div className="flex flex-col gap-3">
                  <AnswerContent message={message} />
                  {message.status === 'loading' && (
                    <div role="status" className="flex items-center gap-2 text-foreground-subtle">
                      <Loader2Icon className="size-4 animate-spin" aria-hidden />
                      正在生成…
                    </div>
                  )}
                  {message.status === 'stopped' && (
                    <p role="status" className="text-foreground-subtle">
                      {message.error ?? '已停止，已生成的内容已保留。'}
                    </p>
                  )}
                  {message.status === 'error' && (
                    <p role="alert" className="text-destructive">
                      {message.error}
                    </p>
                  )}
                  {message.status === 'done' && message.parts.length === 0 && (
                    <p className="text-foreground-subtle">本次未返回正文。</p>
                  )}
                  {(message.status === 'error' || message.status === 'stopped') && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => onRetry(message)}
                      className="self-start rounded-md"
                    >
                      <RotateCcwIcon />
                      重新提问
                    </Button>
                  )}
                </div>
              </article>
            )}
          </li>
        ))}
      </ol>
      <div ref={end} />
    </div>
  )
}
