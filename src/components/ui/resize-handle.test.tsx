import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ResizeHandle } from './resize-handle'

it('方向键按步长调整并限制在上下限内；invert 时向上变大', () => {
  const onChange = vi.fn()
  const { rerender } = render(
    <ResizeHandle
      orientation="vertical"
      label="宽度"
      value={256}
      min={208}
      max={400}
      onChange={onChange}
    />,
  )
  const handle = screen.getByRole('separator', { name: '宽度' })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(onChange).toHaveBeenLastCalledWith(272)
  fireEvent.keyDown(handle, { key: 'End' })
  expect(onChange).toHaveBeenLastCalledWith(400)
  rerender(
    <ResizeHandle
      orientation="vertical"
      label="宽度"
      value={210}
      min={208}
      max={400}
      onChange={onChange}
    />,
  )
  fireEvent.keyDown(handle, { key: 'ArrowLeft' })
  expect(onChange).toHaveBeenLastCalledWith(208)
  rerender(
    <ResizeHandle
      orientation="horizontal"
      invert
      label="高度"
      value={100}
      min={48}
      max={480}
      onChange={onChange}
    />,
  )
  fireEvent.keyDown(screen.getByRole('separator', { name: '高度' }), { key: 'ArrowUp' })
  expect(onChange).toHaveBeenLastCalledWith(116)
})
