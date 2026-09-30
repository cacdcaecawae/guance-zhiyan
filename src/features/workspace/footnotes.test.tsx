import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { Markdown } from './markdown'

const text = '正文[^1]，再次引用[^1]\n\n[^1]: 合成脚注正文'

it.each(['1', '中文注释'])(
  '各段脚注拥有唯一 ID、中文读屏名称及正确的本段引用和返回目标：%s',
  (label) => {
    const labeled = text.replaceAll('[^1]', `[^${label}]`)
    const { container } = render(
      <>
        <Markdown text={labeled} />
        <Markdown text={labeled} />
      </>,
    )
    const ids = [...container.querySelectorAll('[id]')].map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(screen.queryByText('Footnotes')).toBeNull()
    for (const part of container.querySelectorAll('.answer-markdown')) {
      const scope = within(part as HTMLElement)
      const references = scope.getAllByRole('link', { name: '脚注 1' })
      expect(references).toHaveLength(2)
      expect(references[0]).toHaveTextContent('注 1')
      const label = scope.getByRole('heading', { name: '脚注' })
      for (const reference of references) {
        expect(reference).toHaveAttribute('aria-describedby', label.id)
        const target = document.getElementById(reference.getAttribute('href')!.slice(1))!
        expect(part.contains(target)).toBe(true)
        expect(target).toHaveTextContent('合成脚注正文')
      }
      const backlinks = scope.getAllByRole('link', { name: /^返回脚注 1/ })
      expect(backlinks).toHaveLength(2)
      expect(backlinks.map((node) => node.getAttribute('href'))).toEqual(
        references.map((node) => '#' + node.id),
      )
    }
  },
)

it('跳转与返回移交焦点但不改变地址，流式重渲染保持目标稳定', () => {
  const { rerender } = render(<Markdown text={text} />)
  const reference = screen.getAllByRole('link', { name: '脚注 1' })[1]
  const targetId = reference.getAttribute('href')!.slice(1)
  const url = location.href
  fireEvent.click(reference)
  expect(document.getElementById(targetId)).toHaveFocus()
  fireEvent.click(screen.getByRole('link', { name: '返回脚注 1（第 2 处引用）' }))
  expect(reference).toHaveFocus()
  expect(location.href).toBe(url)
  rerender(<Markdown text={text + '\n\n新的正文'} />)
  expect(screen.getAllByRole('link', { name: '脚注 1' })[1]).toHaveAttribute('href', '#' + targetId)
})

it('只放行转换器生成的脚注片段，普通 Markdown 不能借同一目标成为链接', () => {
  const { rerender } = render(<Markdown text={text} />)
  const href = screen.getAllByRole('link', { name: '脚注 1' })[0].getAttribute('href')
  rerender(
    <Markdown text={`${text}\n\n[伪造脚注](${href}) [其他片段](#app) [相对接口](/api/me)`} />,
  )
  for (const name of ['伪造脚注', '其他片段', '相对接口']) {
    expect(screen.getByText(name)).not.toHaveAttribute('href')
    expect(screen.queryByRole('link', { name })).toBeNull()
  }
  expect(screen.getAllByRole('link')).toHaveLength(4)
})

it('脚注标签不会与重复引用的后缀碰撞，大小写匹配与返回目标保持正确', () => {
  const { container } = render(
    <Markdown text={'甲[^A]、甲再次[^a]、乙[^a-2]\n\n[^a]: 甲的注释\n\n[^A-2]: 乙的注释'} />,
  )
  const ids = [...container.querySelectorAll('[id]')].map((node) => node.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(screen.getAllByRole('link', { name: '脚注 1' })).toHaveLength(2)
  const second = screen.getByRole('link', { name: '脚注 2' })
  const backlink = screen.getByRole('link', { name: '返回脚注 2' })
  expect(backlink).toHaveAttribute('href', '#' + second.id)
  fireEvent.click(backlink)
  expect(second).toHaveFocus()
})
