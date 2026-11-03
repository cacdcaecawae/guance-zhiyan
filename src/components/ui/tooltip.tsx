import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import type { ReactElement } from 'react'

// 图标按钮的悬停 / 键盘聚焦提示，替代浏览器原生 title；样式同菜单弹层。触屏不弹出（Radix 忽略 touch 指针），
// 点击即收起。程序化聚焦（如菜单关闭后焦点回到触发按钮）不算键盘聚焦，不弹出。
// 只做视觉提示：按钮的可访问名称仍由它自己的 aria-label 给出。
// Trigger 会用自己的 data-state 覆盖子元素的，包住菜单触发器时展开样式写 aria-expanded:，不写 data-[state=open]:。
export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger
          asChild
          onFocus={(event) => {
            if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
          }}
        >
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-xs rounded-lg border border-popover-border bg-popover px-2 py-1 text-ui-sm text-foreground shadow-md select-none"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
