import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

// shadcn/ui 风格按钮，绑定本项目语义 tokens。默认圆角 rounded-lg；位于圆角容器内时传 className="rounded-md"。
// 点击后会暂时不可用的按钮用 aria-disabled 而非 disabled，焦点不会因禁用掉回页面开头；调用方自行拦截点击。
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-ui-base font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-border bg-surface hover:border-border-hover hover:bg-hover',
        ghost: 'text-foreground-subtle hover:bg-hover hover:text-foreground',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2 text-ui-sm',
        icon: 'size-8',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}
