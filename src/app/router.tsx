import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigationType,
  useParams,
} from 'react-router'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { initialize, login, useResearch } from '@/services/research'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from './theme-toggle'
import { LibraryDocumentPage } from '@/features/library/library-document'
import { LibraryPage } from '@/features/library/library-page'
import { OutputsPage } from '@/features/outputs/outputs-page'
import { WorkspacePage } from '@/features/workspace/workspace-page'
import { AppShell } from './shell'
import { SlipsMark } from './logo'

function WorkspaceRoute() {
  const { sessionId } = useParams()
  const location = useLocation()
  const navigationType = useNavigationType()
  const [workspace, setWorkspace] = useState({ location, key: 0 })
  if (workspace.location !== location) {
    // 仅首次发送的自动跳转延续工作区；普通导航和历史前进 / 后退均重置草稿。
    const promoted =
      navigationType === 'PUSH' &&
      (location.state as { createdFrom?: string } | null)?.createdFrom === workspace.location.key
    setWorkspace({ location, key: workspace.key + (promoted ? 0 : 1) })
  }
  return <WorkspacePage key={workspace.key} sessionId={sessionId} />
}

export function AppRouter() {
  return (
    <AuthenticationBoundary>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/workspace" replace />} />
            <Route path="/workspace/:sessionId?" element={<WorkspaceRoute />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/library/document" element={<LibraryDocumentPage />} />
            <Route path="/outputs" element={<OutputsPage />} />
            <Route path="*" element={<Navigate to="/workspace" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthenticationBoundary>
  )
}

function AuthenticationBoundary({ children }: { children: ReactNode }) {
  const { user, loading, error, needsLogin } = useResearch()
  useEffect(() => {
    void initialize()
  }, [])
  if (user) return children
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <section className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border bg-card p-6">
        <h1 className="flex items-center gap-2 text-ui-lg font-semibold">
          <SlipsMark size={28} />
          管策智研
        </h1>
        {loading ? (
          <p role="status">正在连接研究工作台…</p>
        ) : needsLogin ? (
          <LoginForm />
        ) : (
          <>
            <p role="alert" className="text-destructive">
              {error}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                void initialize()
              }}
            >
              重试连接
            </Button>
          </>
        )}
        <ThemeToggle />
      </section>
    </main>
  )
}

const FIELD =
  'h-8 w-full min-w-0 rounded-lg border border-input-border bg-input px-3 text-ui-base text-foreground outline-none transition-colors hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused'

/** 服务器模式未登录时，任何页面都先显示登录表单，登录后留在原地址。 */
function LoginForm() {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    try {
      await login(String(form.get('username')), String(form.get('password')))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '登录失败，请重试。')
      setPending(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-ui-base">
        用户名
        <input name="username" autoComplete="username" required autoFocus className={FIELD} />
      </label>
      <label className="flex flex-col gap-1 text-ui-base">
        密码
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={FIELD}
        />
      </label>
      {error && (
        <p role="alert" className="text-ui-caption text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" aria-disabled={pending}>
        {pending ? '正在登录…' : '登录'}
      </Button>
    </form>
  )
}
