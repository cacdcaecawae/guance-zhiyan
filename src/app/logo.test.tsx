import { fireEvent, render } from '@testing-library/react'
import { expect, it } from 'vitest'
import { SlipsMark } from './logo'

// 竹简对读屏隐藏、只响应指针，所以按类名取
const slips = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.slip')]
const picked = (root: HTMLElement) => slips(root).flatMap((s, i) => (s.dataset.on ? [i] : []))
const effects = (root: HTMLElement) =>
  slips(root).map((s) => s.querySelector<HTMLElement>('.slip-fx')?.dataset.fx)

it('点哪一枚竹简就抽出哪一枚，再点同一枚仍保持抽出', () => {
  const { container } = render(<SlipsMark size={36} />)
  expect(picked(container)).toEqual([3])
  expect(effects(container)).toEqual(Array(7).fill(undefined))

  fireEvent.click(slips(container)[1])
  expect(picked(container)).toEqual([1])
  expect(effects(container)).toEqual(['wave', 'hit', 'wave', 'drop', 'wave', 'wave', 'wave'])

  fireEvent.click(slips(container)[1])
  expect(picked(container)).toEqual([1])
  expect(effects(container)[1]).toBe('bob')
})

it('生成中的竹简依次抽出，不响应点击', () => {
  const { container } = render(<SlipsMark size={20} loading />)
  fireEvent.click(slips(container)[0])
  expect(picked(container)).toEqual([])
  expect(effects(container)).toEqual(Array(7).fill(undefined))
  expect(container.querySelector('.slips')).toHaveAttribute('data-loading')
})

it('小尺寸下竹简落在整像素上、粗细一致，缝不小于 1px', () => {
  const { container } = render(<SlipsMark size={20} loading />)
  const box = (s: HTMLElement) => ({ left: s.style.left, width: s.style.width })
  expect(slips(container).map(box)).toEqual(
    [0, 3, 6, 9, 12, 15, 18].map((left) => ({ left: `${left}px`, width: '2px' })),
  )
})
