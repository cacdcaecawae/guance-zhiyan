import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router'
import { useEffect, type ReactNode } from 'react'
import { initialize, useResearch } from '@/services/research'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from './theme-toggle'
import { LibraryPage } from '@/features/library/library-page'
import { OutputsPage } from '@/features/outputs/outputs-page'
import { WorkspacePage } from '@/features/workspace/workspace-page'
import { AppShell } from './shell'
import { Seal } from './logo'

function WorkspaceRoute() {
  const { sessionId } = useParams()
  // 切换会话时重置草稿和操作错误。
  return <WorkspacePage key={sessionId} sessionId={sessionId} />
}

export function AppRouter() {
  return (
    <AuthenticationBoundary>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/workspace" replace />} />
            <Route path="/workspace" element={<WorkspaceRoute />} />
            <Route path="/workspace/:sessionId" element={<WorkspaceRoute />} />
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
          <Seal size={28} />
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
