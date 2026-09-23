import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useTheme, type Theme } from './theme'

const OPTIONS: { value: Theme; label: string; Icon: typeof SunIcon }[] = [
  { value: 'light', label: '浅色', Icon: SunIcon },
  { value: 'dark', label: '深色', Icon: MoonIcon },
  { value: 'system', label: '跟随系统', Icon: MonitorIcon },
]

export function ThemeToggle() {
  const [theme, setTheme] = useTheme()
  return (
    <div
      role="group"
      aria-label="主题"
      className="inline-flex gap-0.5 rounded-lg border border-border bg-surface p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md text-foreground-subtle outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            theme === value && 'bg-selected text-foreground',
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  )
}
