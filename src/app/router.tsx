import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigationType,
  useParams,
} from 'react-router'
import { useEffect, useState, type ReactNode } from 'react'
import { initialize, useResearch } from '@/services/research'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from './theme-toggle'
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
            <Route path="/outputs" element={<OutputsPage />} />
            <Route path="*" element={<Navigate to="/workspace" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthenticationBoundary>
  )
}

function AuthenticationBoundary({ children }: { children: ReactNode }) {
  const { user, loading, error } = useResearch()
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
