import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { TopBar } from '@/app/shell'
import { Button } from '@/components/ui/button'
import { askQuestion, createSession, retryAnswer, useSessions } from '@/services/research'
import type { Citation } from '@/types'
import { Composer } from './composer'
import { MessageList } from './message-list'
import { SourcePanel } from './source-panel'
import { Welcome } from './welcome'

interface WorkspacePageProps {
  sessionId?: string
}

/** 中央研究工作区 + 按需展开的右侧资料面板。 */
export function WorkspacePage({ sessionId }: WorkspacePageProps) {
  const sessions = useSessions()
  const navigate = useNavigate()
  const session = sessions.find((s) => s.id === sessionId)
  const [activePassageId, setActivePassageId] = useState<string | null>(null)

  if (sessionId && !session) {
    return (
      <>
        <TopBar title="会话不存在" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-foreground-subtle">
          <p>没有找到这个会话。会话仅保存在内存中，刷新页面后新建的会话会丢失。</p>
          <Button variant="outline" asChild>
            <Link to="/workspace">返回工作台</Link>
          </Button>
        </div>
      </>
    )
  }

  const messages = session?.messages ?? []
  const busy = messages.some((m) => m.role === 'assistant' && m.status === 'loading')

  const submit = (question: string) => {
    let id = session?.id
    if (!id) {
      id = createSession().id
      navigate(`/workspace/${id}`)
    }
    askQuestion(id, question)
  }

  const openCitation = (c: Citation) => setActivePassageId(c.passageId)

  return (
    <>
      <TopBar title={session?.title ?? '研究工作台'} />
      <div className="flex min-h-0 flex-1">
        <section aria-label="研究工作区" className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            {messages.length === 0 ? (
              <Welcome onPick={submit} />
            ) : (
              <MessageList
                messages={messages}
                activePassageId={activePassageId}
                onOpenCitation={openCitation}
                onRetry={(message) => retryAnswer(session!.id, message)}
              />
            )}
          </div>
          <div className="shrink-0 px-4 pb-4">
            <div className="mx-auto w-full max-w-2xl">
              <Composer onSubmit={submit} busy={busy} />
              <p className="mt-1.5 text-ui-sm text-foreground-subtlest">
                Enter 发送，Shift+Enter 换行。演示模式下回答为预设内容。
              </p>
            </div>
          </div>
        </section>
        <SourcePanel passageId={activePassageId} onClose={() => setActivePassageId(null)} />
      </div>
    </>
  )
}
