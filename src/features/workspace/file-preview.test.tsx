import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Artifact } from '@/types'
import { FilePreview } from './file-preview'

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

it('不支持的格式与过大文件不请求内容；读取失败可重试', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('文件读取失败（500），请重试。'))
  vi.stubGlobal('fetch', fetch)
  const { unmount } = render(<FilePreview file={file('docx')} />)
  expect(screen.getByText('DOCX 文件暂不支持在线预览，请下载后查看。')).toBeInTheDocument()
  unmount()
  const big = render(<FilePreview file={file('md', 3 * 1024 * 1024)} />)
  expect(screen.getByText('文件较大，请下载后查看。')).toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
  big.unmount()
  render(<FilePreview file={file('txt')} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('文件读取失败（500）')
  fetch.mockResolvedValueOnce(new Response('原文'))
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('原文')).toBeInTheDocument()
})
