import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { Markdown } from './markdown'

it('原文引用仅放行精确片段路径，保留 HTTP 链接并拒绝其他相对地址和协议', () => {
  const path = '/api/library/passages/01234567-89ab-5def-a123-456789abcdef'
  render(
    <Markdown
      text={[
        `[原文](${path})`,
        '[网页](https://example.org/policy)',
        '[普通 HTTP](http://example.org/policy)',
        '[其他接口](/api/me)',
        `[非精确路径](${path.replace('/api/', '/API/')})`,
        '[相对路径](../policy)',
        '[跨站相对](//example.org/policy)',
        '[脚本](javascript:alert%281%29)',
        '[数据](data:text/plain,hello)',
        '[本机文件](file:///etc/passwd)',
        `[查询参数](${path}?format=json)`,
        `[片段标识](${path}#section)`,
        `[附加路径](${path}/extra)`,
        '[无效编号](/api/library/passages/------------------------------------)',
        '[编码路径](/api%2flibrary/passages/01234567-89ab-5def-a123-456789abcdef)',
        '<script>alert(1)</script>',
        '![外部图片](https://example.org/image.png)',
      ].join('\n\n')}
    />,
  )
  expect(screen.getAllByRole('link')).toHaveLength(3)
  expect(screen.getByRole('link', { name: '原文 1' })).toHaveAttribute('href', path)
  expect(screen.getByRole('link', { name: '原文 1' })).toHaveAttribute('rel', 'noopener noreferrer')
  expect(screen.getByRole('link', { name: '网页' })).toHaveAttribute(
    'href',
    'https://example.org/policy',
  )
  expect(screen.getByText('其他接口')).not.toHaveAttribute('href')
  expect(document.querySelector('script')).toBeNull()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

it('原文引用按首次出现顺序编号，同一片段复用编号', () => {
  const first = '/api/library/passages/01234567-89ab-5def-a123-456789abcdef'
  const second = '/api/library/passages/fedcba98-7654-5321-afed-cba987654321'
  render(
    <Markdown
      text={`养老服务[原文](${first})，住房保障[原文](${second})，再次引用[原文](${first.toUpperCase().replace('/API/LIBRARY/PASSAGES/', '/api/library/passages/')})。`}
    />,
  )
  const links = screen.getAllByRole('link')
  expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
    '原文 1',
    '原文 2',
    '原文 1',
  ])
  expect(links.map((link) => link.textContent)).toEqual(['1', '2', '1'])
})

it('描述性标签保留为文字并附编号；未在正文中出现的片段路径不成链接', () => {
  const path = '/api/library/passages/01234567-89ab-5def-a123-456789abcdef'
  render(
    <Markdown
      text={`根据[《测试条例》第三条](${path})规定。编码写法[原文](&#47;api/library/passages/fedcba98-7654-5321-afed-cba987654321)。`}
    />,
  )
  expect(screen.getByText(/《测试条例》第三条/)).toBeInTheDocument()
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link', { name: '原文 1' })).toHaveAttribute('href', path)
})
