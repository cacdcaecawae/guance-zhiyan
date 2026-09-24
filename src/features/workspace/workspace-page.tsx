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
import { Welcome } from './welcome'
import type { ModelSelection } from '@/types'

export function WorkspacePage({ sessionId }: { sessionId?: string }) {
  const { current, catalog, loading, error, connectionError } = useResearch()
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
  const provider = catalog?.providers.find((item) => item.id === selection?.provider)
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
      <TopBar title={session?.title ?? '研究工作台'} />
      <section aria-label="研究工作区" className="flex min-h-0 flex-1 flex-col">
        <div data-message-scroll className="min-h-0 flex-1 overflow-y-auto px-4">
          {loading ? (
            <p role="status" className="p-6 text-foreground-subtle">
              正在加载会话…
            </p>
          ) : error ? (
            <div className="mx-auto flex max-w-2xl flex-col gap-3 py-6">
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
            <section aria-label="会话文件" className="mx-auto mb-4 flex max-w-2xl flex-col gap-2">
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
        <div className="shrink-0 px-4 pb-4">
          <div className="mx-auto max-w-2xl">
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
            {!error && (
              <div className="mb-2 flex flex-wrap gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-ui-sm text-foreground-subtle">
                  供应商
                  <select
                    aria-label="供应商"
                    disabled={busy || loading}
                    value={selection?.provider ?? ''}
                    className="h-8 min-w-0 rounded-lg border border-input-border bg-input px-2 text-ui-caption text-foreground outline-none hover:border-input-border-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    onChange={(event) => {
                      const next = catalog?.providers.find((item) => item.id === event.target.value)
                      if (next) setChosen({ provider: next.id, model: next.models[0].id })
                    }}
                  >
                    {catalog?.providers.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.configured ? '' : '（未配置密钥）'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-ui-sm text-foreground-subtle">
                  模型
                  <select
                    aria-label="模型"
                    disabled={busy || loading}
                    value={selection?.model ?? ''}
                    className="h-8 min-w-0 rounded-lg border border-input-border bg-input px-2 text-ui-caption text-foreground outline-none hover:border-input-border-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    onChange={(event) => {
                      if (selection)
                        setChosen({ provider: selection.provider, model: event.target.value })
                    }}
                  >
                    {provider?.models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="w-full text-ui-sm text-foreground-subtlest">
                  所选平台将接收本会话历史并提供回答与联网搜索。
                </p>
              </div>
            )}
            {!error && (
              <Composer
                onSubmit={submit}
                busy={busy || loading}
                onStop={session?.running ? stop : undefined}
              />
            )}
            <p className="mt-1.5 text-ui-sm text-foreground-subtlest">
              Enter 发送，Shift+Enter 换行。联网资料需核对来源；文献库检索尚未实现。
            </p>
          </div>
        </div>
      </section>
    </>
  )
}
