import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
// 顶栏经侧栏引入主题模块，模块加载时即读取 matchMedia，jsdom 没有它
vi.hoisted(() =>
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })),
)
import { LibraryDocumentPage } from './library-document'
import { LibraryPage } from './library-page'

const passage = (n: number) => ({
  id: `00000000-0000-5000-8000-00000000000${n}`,
  ordinal: n,
  heading: n ? '# 计划纲要 / ## 二、调整工业结构' : '',
  text: `第 ${n + 1} 块原文`,
})
const fetchMock = vi.fn(async (path: string) => {
  if (path.startsWith('/api/library?'))
    return Response.json({
      total: 51,
      documents: [{ id: '2561', title: '沧州市“十五”计划', sourceUrl: null, publishedAt: null }],
    })
  if (path.startsWith('/api/library/search?'))
    return Response.json({
      passages: [
        {
          ...passage(1),
          documentId: '2561',
          title: '沧州市“十五”计划',
          text: '## 二、调整工业结构\n\n　　化工产业原文\n1\\.5 倍',
        },
      ],
    })
  if (path === '/api/library/documents/2561')
    return Response.json({
      id: '2561',
      versionId: 'v1',
      title: '沧州市“十五”计划',
      sourceUrl: 'javascript:alert(1)',
      publishedAt: '2001-03-01',
      passages: [passage(0), passage(1)],
    })
  return Response.json({ error: '没有找到文献。' }, { status: 404 })
})
vi.stubGlobal('fetch', fetchMock)
afterEach(() => fetchMock.mockClear())

const open = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      {/* 模拟侧栏的“文献库”链接：页面不重新挂载时表单也随地址重置 */}
      <Link to="/library">侧栏文献库</Link>
      <Routes>
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/library/:documentId" element={<LibraryDocumentPage />} />
      </Routes>
    </MemoryRouter>,
  )

it('按标题检索、翻页，点开文献按顺序显示全部片段，返回时保留检索词与页码', async () => {
  const user = userEvent.setup()
  open('/library')
  expect(await screen.findByText('共 51 篇文献')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenLastCalledWith('/api/library?limit=50&offset=0', expect.anything())

  await user.type(screen.getByRole('searchbox', { name: '检索词' }), ' 沧州 十五 {Enter}')
  expect(await screen.findByText('标题含“沧州 十五”的文献共 51 篇')).toBeInTheDocument()
  // 检索后表单不重建，焦点仍在检索框
  expect(screen.getByRole('searchbox', { name: '检索词' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: '下一页' }))
  expect(await screen.findByText('第 2 / 2 页')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/library?${new URLSearchParams({ q: '沧州 十五', limit: '50', offset: '50' })}`,
    expect.anything(),
  )

  await user.click(screen.getByRole('link', { name: /沧州市“十五”计划/ }))
  const passages = within(await screen.findByRole('list')).getAllByRole('listitem')
  expect(passages.map((item) => item.textContent)).toEqual([
    '片段 1第 1 块原文',
    '片段 2 · 计划纲要 / 二、调整工业结构第 2 块原文',
  ])
  expect(screen.getByText(/文献编号 2561 · 发布于 2001-03-01 · 共 2 个片段/)).toBeInTheDocument()
  // 来源不是 HTTP(S) 链接时不显示
  expect(screen.queryByRole('link', { name: '原始来源' })).toBeNull()

  await user.click(screen.getByRole('link', { name: '返回文献库' }))
  expect(await screen.findByText('第 2 / 2 页')).toBeInTheDocument()
  expect(screen.getByRole('searchbox', { name: '检索词' })).toHaveValue('沧州 十五')
})

it('从引用进入时定位并标出被引片段', async () => {
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  open(`/library/2561#${passage(1).id}`)
  const target = await screen.findByText('第 2 块原文')
  expect(target.closest('li')).toHaveAttribute('aria-current', 'true')
  expect(scroll).toHaveBeenCalledOnce()
})

it('读取失败时写明原因并可重试', async () => {
  const user = userEvent.setup()
  open('/library/missing')
  expect(await screen.findByRole('alert')).toHaveTextContent('没有找到文献。')
  await user.click(screen.getByRole('button', { name: '重试' }))
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('按内容检索调用混合检索，列出片段摘要，点开后定位到该片段；切回按标题保留检索词', async () => {
  const user = userEvent.setup()
  Element.prototype.scrollIntoView = vi.fn()
  open('/library')
  await screen.findByText('共 51 篇文献')
  await user.click(screen.getByRole('radio', { name: '按内容' }))
  expect(screen.getByRole('radio', { name: '按内容' })).toBeChecked()
  await user.type(screen.getByRole('searchbox', { name: '检索词' }), '化工 发展重点{Enter}')
  expect(
    await screen.findByText('与“化工 发展重点”最相关的 1 个片段，按相关度从高到低排列'),
  ).toBeInTheDocument()
  expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/library/search?${new URLSearchParams({ q: '化工 发展重点' })}`,
    expect.anything(),
  )
  const hit = screen.getByRole('link', { name: /沧州市“十五”计划/ })
  expect(hit).toHaveTextContent('文献编号 2561 · 片段 2 · 计划纲要 / 二、调整工业结构')
  // 摘要去掉与章节重复的标题行、转义符和多余空白
  expect(hit).toHaveTextContent(/二、调整工业结构化工产业原文 1\.5 倍$/)
  await user.click(hit)
  expect((await screen.findByText('第 2 块原文')).closest('li')).toHaveAttribute(
    'aria-current',
    'true',
  )
  await user.click(screen.getByRole('link', { name: '返回文献库' }))
  expect(await screen.findByRole('radio', { name: '按内容' })).toBeChecked()
  expect(screen.getByRole('searchbox', { name: '检索词' })).toHaveValue('化工 发展重点')
  await user.click(screen.getByRole('radio', { name: '按标题' }))
  expect(await screen.findByText('标题含“化工 发展重点”的文献共 51 篇')).toBeInTheDocument()
})

it('页面外的链接改变地址时，表单同步为地址里的检索方式与检索词', async () => {
  const user = userEvent.setup()
  open('/library?by=content&q=' + encodeURIComponent('化工'))
  expect(await screen.findByText(/与“化工”最相关/)).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: '按内容' })).toBeChecked()
  await user.click(screen.getByRole('link', { name: '侧栏文献库' }))
  expect(await screen.findByText('共 51 篇文献')).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: '按标题' })).toBeChecked()
  expect(screen.getByRole('searchbox', { name: '检索词' })).toHaveValue('')
})
