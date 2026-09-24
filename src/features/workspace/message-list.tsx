import { Loader2Icon, RotateCcwIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import type { AssistantMessage, Message } from '@/types'
import { Markdown } from './markdown'
import { Reasoning } from './reasoning'

const toolNames: Record<string, string> = {
  web_search: '联网搜索',
  web_fetch: '读取网页',
  create_file: '生成文件',
  read_file: '读取文件',
  list_files: '列出文件',
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
    <div className="mx-auto w-full max-w-2xl py-4">
      <ol className="flex flex-col gap-4">
        {messages.map((message) => (
          <li key={message.id} className={message.role === 'user' ? 'flex justify-end' : undefined}>
            {message.role === 'user' ? (
              <div className="max-w-[85%] rounded-xl bg-accent px-4 py-2 whitespace-pre-wrap">
                {message.text}
              </div>
            ) : (
              <article
                aria-label="回答"
                className="min-w-0 rounded-xl border border-card-border bg-card px-4 py-3"
              >
                <div className="flex flex-col gap-3">
                  {message.parts.map((part) =>
                    part.type === 'text' ? (
                      <Markdown key={part.id} text={part.text} />
                    ) : part.type === 'reasoning' ? (
                      <Reasoning
                        key={part.id}
                        text={part.text}
                        running={message.status === 'loading' && part === message.parts.at(-1)}
                      />
                    ) : (
                      <details
                        key={part.id}
                        className="min-w-0 rounded-lg border border-border px-3 py-2"
                      >
                        <summary className="cursor-pointer rounded-md text-ui-caption outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {toolNames[part.name] ?? part.name} ·{' '}
                          {part.status === 'running'
                            ? '执行中'
                            : part.status === 'done'
                              ? '已完成'
                              : '失败 / 已中断'}
                        </summary>
                        <p className="mt-2 text-ui-sm text-foreground-subtlest">调用参数</p>
                        <pre className="max-h-40 overflow-auto text-ui-sm whitespace-pre-wrap">
                          {part.input}
                        </pre>
                        {part.output && (
                          <>
                            <p className="mt-2 text-ui-sm text-foreground-subtlest">执行结果</p>
                            <pre className="max-h-60 overflow-auto text-ui-sm whitespace-pre-wrap">
                              {part.output}
                            </pre>
                          </>
                        )}
                      </details>
                    ),
                  )}
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
