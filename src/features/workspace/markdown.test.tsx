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
  expect(screen.getByRole('link', { name: '原文' })).toHaveAttribute('href', path)
  expect(screen.getByRole('link', { name: '原文' })).toHaveAttribute('rel', 'noopener noreferrer')
  expect(screen.getByRole('link', { name: '网页' })).toHaveAttribute(
    'href',
    'https://example.org/policy',
  )
  expect(screen.getByText('其他接口')).not.toHaveAttribute('href')
  expect(document.querySelector('script')).toBeNull()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
