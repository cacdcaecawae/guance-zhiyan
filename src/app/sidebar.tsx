import { BookOpenIcon, FileTextIcon, MessageSquareIcon, PlusIcon } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { createSession, useResearch } from '@/services/research'
import { Logo } from './logo'
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
  const { sessions, user } = useResearch()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const newResearch = async () => {
    setCreating(true)
    setError(null)
    try {
      const s = await createSession()
      navigate(`/workspace/${s.id}`)
      onNavigate?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '新建失败，请重试。')
    } finally {
      setCreating(false)
    }
  }

  return (
    <nav aria-label="主导航" className="flex h-full min-h-0 flex-col gap-4 p-3">
      <div className="flex items-center gap-2.5 px-2 pt-1">
        <Logo className="size-8 shrink-0" />
        <div className="min-w-0">
          <div className="font-serif text-ui-lg font-semibold tracking-wide">管策智研</div>
          <div className="text-ui-sm text-foreground-subtlest">政策文本研究工作台</div>
        </div>
      </div>

      <Button
        variant="outline"
        className="w-full justify-start"
        onClick={newResearch}
        disabled={creating}
      >
        <PlusIcon />
        新建研究
      </Button>
      {error && (
        <p role="alert" className="text-ui-caption text-destructive">
          {error}
        </p>
      )}

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
        <div className="px-2 text-ui-sm font-medium text-foreground-subtlest">我的会话</div>
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
        <span className="min-w-0 truncate text-ui-sm text-foreground-subtle" title={user?.name}>
          {user?.name}
        </span>
        <ThemeToggle />
      </div>
    </nav>
  )
}
