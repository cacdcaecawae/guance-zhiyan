import { PanelLeftIcon } from 'lucide-react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { Outlet } from 'react-router'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { readPref, writePref } from '@/lib/storage'
import { useMediaQuery } from '@/lib/use-media-query'
import { Sidebar } from './sidebar'

const SIDEBAR_STORAGE_KEY = 'gczy.sidebar-collapsed'
const ShellContext = createContext({ toggle: () => {}, expanded: false })

/** 三栏布局的外壳：左侧导航（宽屏常驻、窄屏抽屉）+ 页面内容。右侧资料面板由工作台页面自行管理。 */
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
          !collapsed && (
            <aside className="w-64 shrink-0 border-r border-border bg-sidebar">
              <Sidebar />
            </aside>
          )
        ) : (
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetContent side="left" title="导航" className="bg-sidebar">
              <Sidebar onNavigate={() => setDrawerOpen(false)} />
            </SheetContent>
          </Sheet>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    </ShellContext.Provider>
  )
}

/** 顶部栏：侧栏开关与页面标题。 */
export function TopBar({ title, children }: { title: string; children?: ReactNode }) {
  const { toggle, expanded } = useContext(ShellContext)
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <Button
        variant="ghost"
        size="icon"
        aria-label="切换侧栏"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <PanelLeftIcon />
      </Button>
      <h1 className="min-w-0 flex-1 truncate text-ui-base font-medium" title={title}>
        {title}
      </h1>
      {children}
    </header>
  )
}
