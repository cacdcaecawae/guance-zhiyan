import { BookOpenIcon, FileTextIcon, MessageSquareIcon, PlusIcon } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { createSession, useSessions } from '@/services/research'
import { ThemeToggle } from './theme-toggle'

const NAV = [
  { to: '/workspace', label: '研究工作台', Icon: MessageSquareIcon, end: true },
  { to: '/library', label: '文献库', Icon: BookOpenIcon, end: false },
  { to: '/outputs', label: '研究成果', Icon: FileTextIcon, end: false },
]

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-ui-base outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring',
    isActive ? 'bg-selected font-medium text-foreground' : 'text-foreground-subtle',
  )

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const sessions = useSessions()
  const navigate = useNavigate()

  const newResearch = () => {
    const s = createSession()
    navigate(`/workspace/${s.id}`)
    onNavigate?.()
  }

  return (
    <nav aria-label="主导航" className="flex h-full min-h-0 flex-col gap-4 p-3">
      <div className="px-2 pt-1">
        <div className="text-ui-lg font-semibold">管策智研</div>
        <div className="text-ui-sm text-foreground-subtlest">政策文本研究工作台</div>
      </div>

      <Button variant="outline" className="w-full justify-start" onClick={newResearch}>
        <PlusIcon />
        新建研究
      </Button>

      <ul className="flex flex-col gap-0.5">
        {NAV.map(({ to, label, Icon, end }) => (
          <li key={to}>
            <NavLink to={to} end={end} className={linkClass} onClick={onNavigate}>
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <div className="px-2 text-ui-sm font-medium text-foreground-subtlest">演示会话</div>
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {sessions.map((s) => (
            <li key={s.id}>
              <NavLink
                to={`/workspace/${s.id}`}
                className={linkClass}
                title={s.title}
                onClick={onNavigate}
              >
                <span className="truncate">{s.title}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-ui-sm text-foreground-subtle">主题</span>
        <ThemeToggle />
      </div>
    </nav>
  )
}
