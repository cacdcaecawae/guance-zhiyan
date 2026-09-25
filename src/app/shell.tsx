import { PanelLeftIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Outlet } from 'react-router'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { readPref, writePref } from '@/lib/storage'
import { useMediaQuery } from '@/lib/use-media-query'
import { Sidebar } from './sidebar'

const SIDEBAR_STORAGE_KEY = 'gczy.sidebar-collapsed'
const SIDEBAR_WIDTH_KEY = 'gczy.sidebar-width'
const SIDEBAR_WIDTH = { min: 208, max: 400, initial: 256 }
const ShellContext = createContext({ toggle: () => {}, expanded: false })

/** 三栏布局的外壳：左侧导航（宽屏常驻、窄屏抽屉）+ 页面内容。右侧文件预览由工作台页面自行管理。 */
export function AppShell() {
  const wide = useMediaQuery('(min-width: 768px)')
  const [collapsed, setCollapsed] = useState(() => readPref(SIDEBAR_STORAGE_KEY) === '1')
  const [drawerOpen, setDrawerOpen] = useState(false)

  const toggleSidebar = () => {
    if (!wide) {
      setDrawerOpen((v) => !v)
      return
    }
    setCollapsed(!collapsed)
    writePref(SIDEBAR_STORAGE_KEY, collapsed ? '0' : '1')
  }

  return (
    <ShellContext.Provider
      value={{ toggle: toggleSidebar, expanded: wide ? !collapsed : drawerOpen }}
    >
      <div className="flex h-dvh bg-background">
        {wide ? (
          !collapsed && <DockedSidebar />
        ) : (
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetContent side="left" title="导航" className="bg-sidebar">
              <Sidebar onNavigate={() => setDrawerOpen(false)} />
            </SheetContent>
          </Sheet>
        )}
        <main className="flex min-w-0 flex-1 flex-col bg-surface">
          <Outlet />
        </main>
      </div>
    </ShellContext.Provider>
  )
}

/** 宽屏常驻侧栏：右边缘可拖动调整宽度，宽度作为界面偏好保存。独立成组件，拖动时只重绘侧栏。 */
function DockedSidebar() {
  const [width, setWidth] = useState(() => {
    const saved = Number(readPref(SIDEBAR_WIDTH_KEY))
    return saved
      ? Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, saved))
      : SIDEBAR_WIDTH.initial
  })
  return (
    <aside style={{ width }} className="relative shrink-0 border-r border-border bg-sidebar">
      <Sidebar />
      <ResizeHandle
        orientation="vertical"
        label="调整侧栏宽度"
        value={width}
        min={SIDEBAR_WIDTH.min}
        max={SIDEBAR_WIDTH.max}
        onChange={(next) => {
          setWidth(next)
          writePref(SIDEBAR_WIDTH_KEY, String(next))
        }}
        className="absolute inset-y-0 -right-1 z-10 w-2 transition-colors hover:bg-brand/25"
      />
    </aside>
  )
}

/** 顶部栏：侧栏开关与页面标题。 */
export function TopBar({ title, children }: { title: string; children?: ReactNode }) {
  const { toggle, expanded } = useContext(ShellContext)
  // 浏览器标签页标题随页面与会话变化，多开时便于区分
  useEffect(() => {
    document.title = `${title} · 管策智研`
  }, [title])
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <Button
        variant="ghost"
        size="icon"
        aria-label="切换侧栏"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <PanelLeftIcon />
      </Button>
      <h1
        className="min-w-0 flex-1 truncate font-serif text-ui-lg font-bold tracking-wide"
        title={title}
      >
        {title}
      </h1>
      {children}
    </header>
  )
}
