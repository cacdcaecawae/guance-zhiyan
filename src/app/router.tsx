import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router'
import { LibraryPage } from '@/features/library/library-page'
import { OutputsPage } from '@/features/outputs/outputs-page'
import { WorkspacePage } from '@/features/workspace/workspace-page'
import { AppShell } from './shell'

function WorkspaceRoute() {
  const { sessionId } = useParams()
  // 以 key 区分会话，切换会话时重置页面内部状态（如右侧面板）
  return <WorkspacePage key={sessionId} sessionId={sessionId} />
}

export function AppRouter() {
  return (
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
  )
}
