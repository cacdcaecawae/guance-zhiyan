import * as SheetPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { useRef, type ComponentProps } from 'react'
import { cn } from '@/lib/cn'

// shadcn/ui Sheet：窄屏抽屉。绑定 bg-popover / border-popover-border。

const Sheet = SheetPrimitive.Root

function SheetContent({
  className,
  children,
  side = 'right',
  title,
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'left' | 'right'
  /** 无障碍标题；视觉上隐藏 */
  title: string
}) {
  const returnFocus = useRef<HTMLElement>(null)
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <SheetPrimitive.Content
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement as HTMLElement
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          // 打开抽屉的按钮可能随导航重新挂载，此时按同名 aria-label 找到新按钮
          const target = returnFocus.current
          const label = target?.getAttribute('aria-label')
          ;(target?.isConnected
            ? target
            : label
              ? document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`)
              : null
          )?.focus()
        }}
        aria-describedby={undefined}
        className={cn(
          'fixed inset-y-0 z-50 flex w-[85vw] max-w-sm flex-col border-popover-border bg-popover shadow-md',
          side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
          className,
        )}
        {...props}
      >
        <SheetPrimitive.Title className="sr-only">{title}</SheetPrimitive.Title>
        {children}
        <SheetPrimitive.Close
          aria-label="关闭"
          className="absolute top-3 right-3 inline-flex size-7 items-center justify-center rounded-lg text-foreground-subtle outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-4" />
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

export { Sheet, SheetContent }
