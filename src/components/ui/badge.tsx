import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/** 弱徽标：唯一允许使用 text-ui-xs 的场景之一 */
function Badge({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="badge"
      className={cn(
        'inline-flex shrink-0 items-center rounded-sm bg-tag px-1.5 py-0.5 text-ui-xs font-medium whitespace-nowrap text-foreground-subtle',
        className,
      )}
      {...props}
    />
  )
}

export { Badge }
