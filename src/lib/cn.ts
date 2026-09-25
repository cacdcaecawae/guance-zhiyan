import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge 不认识自定义的 text-ui-* 字号，会把它当作文字颜色，与 text-foreground 等互相覆盖。
// 在此登记为字号组；tokens.css 增删 --text-ui-* 时同步。
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'ui-xs',
            'ui-sm',
            'ui-caption',
            'ui-base',
            'ui-prose',
            'ui-lg',
            'ui-xl',
            'ui-display',
          ],
        },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
