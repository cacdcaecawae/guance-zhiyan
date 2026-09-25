import { BookOpenIcon, FileTextIcon, MessageSquareIcon, PlusIcon } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { createSession, useResearch } from '@/services/research'
import { Nameplate } from './logo'
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
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const s = await createSession()
      navigate(`/workspace/${s.id}`, { state: { focusComposer: true } })
      onNavigate?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '新建失败，请重试。')
    } finally {
      setCreating(false)
    }
  }

  return (
    <nav aria-label="主导航" className="flex h-full min-h-0 flex-col gap-4 p-3">
      {/* 铭牌与校名署名：配色呼应社科大的中国红 */}
      <div className="flex flex-col items-center gap-2 border-b border-border px-1 pt-1 pb-3">
        <Nameplate width={216} className="h-auto w-full max-w-52" />
        <div className="pl-[0.3em] font-serif text-ui-caption font-semibold tracking-[0.3em] text-foreground">
          中国社会科学院大学
        </div>
      </div>

      <Button
        variant="outline"
        className="w-full justify-start bg-card [&_svg]:text-brand"
        onClick={newResearch}
        aria-disabled={creating}
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
        <div className="px-2 text-ui-sm tracking-widest text-foreground-subtlest">研究记录</div>
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {sessions.map((s) => (
            <li key={s.id}>
              <NavLink
                to={`/workspace/${s.id}`}
                className={({ isActive }) =>
                  cn(
                    'relative flex h-8 min-w-0 items-center rounded-md px-2 text-ui-base outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'bg-selected font-medium text-foreground'
                      : 'text-foreground-subtle hover:bg-hover',
                  )
                }
                title={s.title}
                onClick={onNavigate}
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <span
                        aria-hidden
                        className="absolute left-0.5 h-3.5 w-0.5 rounded-sm bg-seal"
                      />
                    )}
                    <span className="truncate">{s.title}</span>
                  </>
                )}
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
