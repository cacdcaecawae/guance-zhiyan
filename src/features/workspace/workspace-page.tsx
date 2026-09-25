import { CircleAlertIcon, DownloadIcon, PaperclipIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { TopBar } from '@/app/shell'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useMediaQuery } from '@/lib/use-media-query'
import {
  artifactUrl,
  askQuestion,
  createSession,
  stopAnswer,
  useResearch,
  watchSession,
} from '@/services/research'
import { Composer } from './composer'
import { FilePreview, FormatBlock, PreviewPane } from './file-preview'
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
  const [previewId, setPreviewId] = useState<string | null>(null)
  const wide = useMediaQuery('(min-width: 1024px)')
  const navigate = useNavigate()
  // 从“新建研究”进入时直接聚焦输入框
  const focusComposer = !!(useLocation().state as { focusComposer?: boolean } | null)?.focusComposer
  // 关闭宽屏预览后把焦点还给对应的文件卡
  const closePreview = () => {
    document.getElementById(`artifact-${previewId}`)?.focus()
    setPreviewId(null)
  }
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
  const preview = session?.artifacts.find((file) => file.id === previewId)
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
  // 连接与操作错误：放进两个视图各自的内容栏顶部，与内容左缘对齐
  const alerts = (connectionError || operationError) && (
    <div className="shrink-0 px-4 pt-3">
      <div className="mx-auto flex max-w-4xl flex-col gap-1.5">
        {connectionError && (
          <div role="alert" className="flex items-start gap-2 text-ui-caption text-destructive">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{connectionError}</span>
            <Button
              variant="outline"
              size="sm"
              className="-my-1 text-foreground"
              onClick={() => setReconnect((value) => value + 1)}
            >
              重新连接
            </Button>
          </div>
        )}
        {operationError && (
          <p role="alert" className="flex items-start gap-2 text-ui-caption text-destructive">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {operationError}
          </p>
        )}
      </div>
    </div>
  )
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
              className={`relative rounded-sm px-1.5 text-ui-caption outline-none transition-colors after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${view === tab ? 'font-medium text-foreground after:bg-seal' : 'text-foreground-subtle hover:text-foreground'}`}
            >
              {tab === 'conversation' ? '对话' : '轨迹'}
            </button>
          ))}
        </div>
      </TopBar>
      <section aria-label="研究工作区" className="flex min-h-0 flex-1 flex-col">
        <div
          role="tabpanel"
          id="trace-panel"
          aria-labelledby="trace-tab"
          hidden={view !== 'trace'}
          className={view === 'trace' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
        >
          {alerts}
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
          className={view !== 'conversation' ? 'hidden' : 'flex min-h-0 flex-1'}
        >
          <div
            className={`flex min-w-0 flex-1 flex-col lg:min-w-80 ${empty ? 'justify-center-safe [@media(min-height:560px)]:pb-12' : ''}`}
          >
            {alerts}
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
                <section aria-label="会话文件" className="mx-auto mb-6 w-full max-w-4xl">
                  <h2 className="mb-3 flex items-center gap-2 font-serif text-ui-base font-semibold">
                    <PaperclipIcon className="size-4 text-foreground-subtlest" aria-hidden />
                    会话文件
                    <span className="font-sans text-ui-sm font-normal text-foreground-subtlest">
                      {session.artifacts.length} 个
                    </span>
                  </h2>
                  {/* 文件卡片：朱红格式块 + 文件名，整卡可点开预览，与正文明显区分 */}
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
                    {session.artifacts.map((file) => (
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
                            onClick={() => setPreviewId(previewId === file.id ? null : file.id)}
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
                </section>
              )}
            </div>
            <div className="shrink-0 px-4 pt-2 pb-5">
              <div className="mx-auto max-w-4xl">
                {!error && (
                  <Composer
                    autoFocus={focusComposer}
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
              </div>
            </div>
          </div>
          {preview && wide && <PreviewPane file={preview} onClose={closePreview} />}
        </div>
        {preview && !wide && (
          <Sheet
            open
            onOpenChange={(open) => {
              if (!open) setPreviewId(null)
            }}
          >
            <SheetContent side="right" title={`预览：${preview.name}`} className="w-full max-w-lg">
              <FilePreview file={preview} />
            </SheetContent>
          </Sheet>
        )}
      </section>
    </>
  )
}
