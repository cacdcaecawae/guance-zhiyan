import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { TopBar } from '@/app/shell'
import { Button } from '@/components/ui/button'
import {
  artifactUrl,
  askQuestion,
  createSession,
  stopAnswer,
  useResearch,
  watchSession,
} from '@/services/research'
import { Composer } from './composer'
import { MessageList } from './message-list'
import { ModelPicker } from './model-picker'
import { Welcome } from './welcome'
import { Trajectory } from './trajectory'
import type { ModelSelection } from '@/types'

export function WorkspacePage({ sessionId }: { sessionId?: string }) {
  const { current, catalog, loading, error, connectionError } = useResearch()
  const [view, setView] = useState<'conversation' | 'trace'>('conversation')
  const [chosen, setChosen] = useState<ModelSelection | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const [reconnect, setReconnect] = useState(0)
  const navigate = useNavigate()
  const createdSession = useRef<string | undefined>(undefined)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => watchSession(sessionId), [sessionId, reconnect])
  const session = current?.id === sessionId ? current : null
  const busy = posting || !!session?.running
  const selection =
    chosen ??
    (session ? { provider: session.provider, model: session.model } : catalog?.defaultSelection)
  const empty = !loading && !error && !session?.messages.length
  const submit = async (question: string) => {
    setPosting(true)
    setOperationError(null)
    try {
      const id = sessionId ?? createdSession.current ?? (await createSession()).id
      createdSession.current = id
      // Admit the request before navigation, preserving the draft on failure.
      await askQuestion(id, question, selection)
      if (!sessionId && mounted.current) navigate(`/workspace/${id}`)
      return true
    } catch (failure) {
      setOperationError(failure instanceof Error ? failure.message : '发送失败，请重试。')
      return false
    } finally {
      setPosting(false)
    }
  }
  const stop = async () => {
    if (!sessionId) return
    try {
      await stopAnswer(sessionId)
    } catch (failure) {
      setOperationError(failure instanceof Error ? failure.message : '停止失败，请重试。')
    }
  }
  return (
    <>
      <TopBar title={session?.title ?? '研究工作台'}>
        <div role="tablist" aria-label="会话视图" className="flex shrink-0 gap-5 self-stretch pr-2">
          {(['conversation', 'trace'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={tab + '-tab'}
              aria-controls={tab + '-panel'}
              aria-selected={view === tab}
              tabIndex={view === tab ? 0 : -1}
              onClick={() => setView(tab)}
              onKeyDown={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  const next =
                    event.key === 'Home'
                      ? 'conversation'
                      : event.key === 'End'
                        ? 'trace'
                        : view === 'conversation'
                          ? 'trace'
                          : 'conversation'
                  setView(next)
                  document.getElementById(next + '-tab')?.focus()
                }
              }}
              className={`relative rounded-sm px-1.5 text-ui-caption outline-none transition-colors after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${view === tab ? 'font-medium text-foreground after:bg-brand' : 'text-foreground-subtle hover:text-foreground'}`}
            >
              {tab === 'conversation' ? '对话' : '轨迹'}
            </button>
          ))}
        </div>
      </TopBar>
      <section aria-label="研究工作区" className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-4">
          {' '}
          {connectionError && (
            <div role="alert" className="mb-2 text-ui-caption text-destructive">
              {connectionError}{' '}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReconnect((value) => value + 1)}
              >
                重新连接
              </Button>
            </div>
          )}
          {operationError && (
            <p role="alert" className="mb-2 text-ui-caption text-destructive">
              {operationError}
            </p>
          )}
        </div>
        <div
          role="tabpanel"
          id="trace-panel"
          aria-labelledby="trace-tab"
          hidden={view !== 'trace'}
          className={view === 'trace' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
        >
          <Trajectory entries={session?.trace ?? []} />
          {session?.running && (
            <Button variant="outline" className="m-3 self-end" onClick={stop}>
              停止生成
            </Button>
          )}
        </div>
        <div
          role="tabpanel"
          id="conversation-panel"
          aria-labelledby="conversation-tab"
          hidden={view !== 'conversation'}
          className={
            view !== 'conversation'
              ? 'hidden'
              : `flex min-h-0 flex-1 flex-col ${empty ? 'justify-center pb-12' : ''}`
          }
        >
          <div
            data-message-scroll
            className={`relative min-h-0 overflow-y-auto px-4 ${empty ? '' : 'flex-1'}`}
          >
            {loading ? (
              <p role="status" className="p-6 text-foreground-subtle">
                正在加载会话…
              </p>
            ) : error ? (
              <div className="mx-auto flex max-w-3xl flex-col gap-3 py-6">
                <p role="alert" className="text-destructive">
                  {error}
                </p>
                <Button variant="outline" onClick={() => setReconnect((value) => value + 1)}>
                  重试加载
                </Button>
                <Link to="/workspace" className="text-brand underline">
                  返回工作台
                </Link>
              </div>
            ) : session?.messages.length ? (
              <MessageList
                messages={session.messages}
                busy={busy}
                onRetry={(message) => {
                  void submit(message.question)
                }}
              />
            ) : (
              <Welcome
                onPick={(question) => {
                  if (!busy) void submit(question)
                }}
              />
            )}
            {!!session?.artifacts.length && (
              <section aria-label="会话文件" className="mx-auto mb-4 flex max-w-4xl flex-col gap-2">
                <h2 className="font-medium">会话文件</h2>
                {session.artifacts.map((file) => (
                  <a
                    key={file.id}
                    href={artifactUrl(file)}
                    className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 wrap-anywhere">{file.name}</span>
                    <span className="text-ui-sm text-foreground-subtle">
                      {Math.ceil(file.size / 1024)} KB · 下载
                    </span>
                  </a>
                ))}
              </section>
            )}
          </div>
          <div className="shrink-0 px-4 pt-2 pb-4">
            <div className="mx-auto max-w-4xl">
              {!error && (
                <Composer
                  onSubmit={submit}
                  busy={busy || loading}
                  onStop={session?.running ? stop : undefined}
                >
                  {catalog && selection && (
                    <ModelPicker
                      catalog={catalog}
                      selection={selection}
                      disabled={busy || loading}
                      onChange={setChosen}
                    />
                  )}
                </Composer>
              )}
              <p className="mt-1.5 text-ui-sm text-balance text-foreground-subtlest">
                所选平台会接收本会话历史 · 联网资料需核对来源 · 文献库检索尚未实现
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
