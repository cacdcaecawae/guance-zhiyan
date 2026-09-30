import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Artifact } from '@/types'
import { FilePreview, PreviewPane } from './file-preview'

const file = (format: string, size = 100): Artifact => ({
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: 's',
  name: `笔记.${format}`,
  format,
  size,
})

afterEach(() => vi.unstubAllGlobals())

it('Markdown 渲染为格式文本，CSV 渲染为表格', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('# 检索笔记\n\n正文')))
  const { unmount } = render(<FilePreview file={file('md')} />)
  expect(await screen.findByRole('heading', { name: '检索笔记' })).toBeInTheDocument()
  unmount()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('方法,数据\n双重差分,"面板,多期"')))
  render(<FilePreview file={file('csv')} />)
  expect(await screen.findByRole('columnheader', { name: '方法' })).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: '面板,多期' })).toBeInTheDocument()
})

it('CSV 空表头和空值行保留，不把第一条数据提升为表头', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('\uFEFF""\r\n"2026-01"\r\n""\r\n"2026-03"\r\n""')),
  )
  render(<FilePreview file={file('csv')} />)
  expect(await screen.findByRole('cell', { name: '2026-01' })).toBeInTheDocument()
  expect(screen.getByRole('columnheader')).toBeEmptyDOMElement()
  expect(screen.getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
    '2026-01',
    '',
    '2026-03',
    '',
  ])
  expect(screen.getAllByRole('row')).toHaveLength(5)
})

it('不支持的格式与过大文件不请求内容；读取失败可重试', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 500 }))
  vi.stubGlobal('fetch', fetch)
  const { unmount } = render(<FilePreview file={file('docx')} />)
  expect(screen.getByText('DOCX 文件暂不支持在线预览')).toBeInTheDocument()
  unmount()
  const big = render(<FilePreview file={file('md', 3 * 1024 * 1024)} />)
  expect(screen.getByText('文件较大，暂不支持在线预览')).toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
  big.unmount()
  render(<FilePreview file={file('txt')} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('文件读取失败（500）')
  fetch.mockResolvedValueOnce(new Response('原文'))
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('原文')).toBeInTheDocument()
})

it('CSV 超过 50 列时截断并提示；Esc 在页面任意位置关闭宽屏预览', async () => {
  const header = Array.from({ length: 60 }, (_, index) => `列${index}`).join(',')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(`${header}
${header}`),
    ),
  )
  const onClose = vi.fn()
  render(<PreviewPane file={file('csv')} onClose={onClose} />)
  expect(await screen.findByText(/共 1 行、60 列/)).toBeInTheDocument()
  expect(screen.getAllByRole('columnheader')).toHaveLength(50)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})
