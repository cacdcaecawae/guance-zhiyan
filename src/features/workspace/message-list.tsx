import { Loader2Icon, RotateCcwIcon } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { DEMO_NOTICE } from '@/services/research'
import type { AssistantMessage, Citation, Message } from '@/types'

interface MessageListProps {
  messages: Message[]
  activePassageId: string | null
  onOpenCitation: (citation: Citation) => void
  onRetry: (message: AssistantMessage) => void
}

export function MessageList({
  messages,
  activePassageId,
  onOpenCitation,
  onRetry,
}: MessageListProps) {
  const endRef = useRef<HTMLOListElement>(null)
  const count = messages.length
  useEffect(() => {
    endRef.current!.scrollIntoView({ block: 'end' })
  }, [count])

  return (
    <ol ref={endRef} className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-4">
      {messages.map((m) =>
        m.role === 'user' ? (
          <li key={m.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-xl bg-accent px-4 py-2 text-ui-base whitespace-pre-wrap">
              {m.text}
            </div>
          </li>
        ) : (
          <li key={m.id}>
            <Answer
              message={m}
              activePassageId={activePassageId}
              onOpenCitation={onOpenCitation}
              onRetry={() => onRetry(m)}
            />
          </li>
        ),
      )}
    </ol>
  )
}

interface AnswerProps {
  message: AssistantMessage
  activePassageId: string | null
  onOpenCitation: (citation: Citation) => void
  onRetry: () => void
}

function Answer({ message, activePassageId, onOpenCitation, onRetry }: AnswerProps) {
  return (
    <article
      aria-label="回答"
      className="rounded-xl border border-card-border bg-card px-4 py-3 text-ui-base"
    >
      <div className="mb-2">
        <Badge>{DEMO_NOTICE}</Badge>
      </div>
      {message.status === 'loading' && (
        <div role="status" className="flex items-center gap-2 text-foreground-subtle">
          <Loader2Icon className="size-4 animate-spin" aria-hidden />
          正在获取演示回答…
        </div>
      )}
      {message.status === 'empty' && (
        <p className="text-foreground-subtle">本次演示未返回内容，请换一个问题重试。</p>
      )}
      {message.status === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <span className="text-destructive">{message.error}</span>
          <Button variant="outline" size="sm" className="rounded-md" onClick={onRetry}>
            <RotateCcwIcon />
            重试
          </Button>
        </div>
      )}
      {message.status === 'done' && (
        <p className="leading-relaxed">
          {renderWithCitations(message, activePassageId, onOpenCitation)}
        </p>
      )}
    </article>
  )
}

const MARKER = /\[(\d+)\]/g

/** 把正文中的 `[n]` 角标替换为可点击的引用按钮 */
function renderWithCitations(
  message: AssistantMessage,
  activePassageId: string | null,
  onOpenCitation: (citation: Citation) => void,
): ReactNode[] {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of message.text.matchAll(MARKER)) {
    const index = match.index
    parts.push(message.text.slice(last, index))
    const marker = Number(match[1])
    const citation = message.citations.find((c) => c.marker === marker)!
    parts.push(
      <button
        key={`${citation.id}-${index}`}
        type="button"
        aria-label={`查看引用 ${marker}`}
        aria-pressed={citation.passageId === activePassageId}
        onClick={() => onOpenCitation(citation)}
        className={cn(
          'mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-brand/40 px-1 align-text-bottom text-ui-xs font-medium text-brand outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          citation.passageId === activePassageId && 'bg-accent',
        )}
      >
        {marker}
      </button>,
    )
    last = index + match[0].length
  }
  parts.push(message.text.slice(last))
  return parts
}
