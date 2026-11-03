import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { Tooltip } from './tooltip'

it('悬停或键盘聚焦时提示，可访问名称仍来自按钮自身', async () => {
  const user = userEvent.setup()
  render(
    <>
      <button type="button">前一个</button>
      <Tooltip label="复制回答">
        <button type="button" aria-label="复制回答" />
      </Tooltip>
    </>,
  )
  const button = screen.getByRole('button', { name: '复制回答' })
  expect(button).not.toHaveAttribute('title')
  expect(screen.queryByRole('tooltip')).toBeNull()
  await user.hover(button)
  expect(await screen.findByRole('tooltip')).toHaveTextContent('复制回答')
  await user.click(button)
  expect(screen.queryByRole('tooltip')).toBeNull()

  await user.unhover(button)
  screen.getByRole('button', { name: '前一个' }).focus()
  await user.tab()
  expect(button).toHaveFocus()
  expect(await screen.findByRole('tooltip')).toHaveTextContent('复制回答')
})
