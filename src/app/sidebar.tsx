import { BookOpenIcon, FileTextIcon, PlusIcon } from 'lucide-react'
import { Link, NavLink } from 'react-router'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useResearch } from '@/services/research'
import { SlipsMark, Wordmark } from './logo'
import { SessionList } from './session-list'
import { ThemeToggle } from './theme-toggle'

const NAV = [
  { to: '/library', label: '文献库', Icon: BookOpenIcon },
  { to: '/outputs', label: '研究成果', Icon: FileTextIcon },
]

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-ui-base outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring',
    isActive ? 'bg-selected font-medium text-foreground' : 'text-foreground-subtle',
  )

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useResearch()
  return (
    <nav aria-label="主导航" className="flex h-full min-h-0 flex-col gap-4 p-3">
      {/* 竹简标志、字标与校名署名 */}
      <div className="flex items-center gap-2.5 border-b border-border px-1 pt-1 pb-3">
        <SlipsMark size={36} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <Wordmark height={18} />
          <div className="font-serif text-ui-sm font-semibold tracking-[0.12em] text-foreground-subtle">
            中国社会科学院大学
          </div>
        </div>
      </div>

      {/* 只打开空白提问页；发出第一个问题时才新建会话，不留下空记录 */}
      <Button variant="outline" className="w-full justify-start bg-card [&_svg]:text-brand" asChild>
        <Link to="/workspace" state={{ focusComposer: true }} onClick={onNavigate}>
          <PlusIcon />
          新建研究
        </Link>
      </Button>

      <ul className="flex flex-col gap-0.5">
        {NAV.map(({ to, label, Icon }) => (
          <li key={to}>
            <NavLink to={to} className={linkClass} onClick={onNavigate}>
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </NavLink>
          </li>
        ))}
      </ul>

      <SessionList onNavigate={onNavigate} />

      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <span className="min-w-0 truncate text-ui-sm text-foreground-subtle" title={user?.name}>
          {user?.name}
        </span>
        <ThemeToggle />
      </div>
    </nav>
  )
}
