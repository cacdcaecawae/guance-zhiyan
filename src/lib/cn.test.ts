import { expect, test } from 'vitest'
import { cn } from './cn'

test('字号 token 与文字颜色互不覆盖，同类仍按后者合并', () => {
  expect(cn('text-ui-caption text-foreground-subtle')).toBe(
    'text-ui-caption text-foreground-subtle',
  )
  expect(cn('text-ui-base text-foreground', 'text-ui-sm')).toBe('text-foreground text-ui-sm')
  expect(cn('text-foreground', 'text-brand')).toBe('text-brand')
})
