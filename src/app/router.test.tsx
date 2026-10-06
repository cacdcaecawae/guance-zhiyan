import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ModelCatalog, Session } from '@/types'

const catalog: ModelCatalog = {
  providers: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek 官方',
      configured: true,
      models: [{ id: 'deepseek-flash', name: 'Flash' }],
    },
  ],
  defaultSelection: { provider: 'deepseek-official', model: 'deepseek-flash' },
}
const session = (id: string): Session => ({
  id,
  title: `研究 ${id}`,
  ...catalog.defaultSelection,
  messages: [],
  artifacts: [],
  trace: [],
  running: false,
})
const image = (name: string) => new File(['synthetic'], name, { type: 'image/png' })
const box = () => screen.getByRole('textbox', { name: '研究问题' })
const send = () => fireEvent.click(screen.getByRole('button', { name: '发送' }))
const attach = (name: string) =>
  fireEvent.change(screen.getByLabelText('选择图片'), { target: { files: [image(name)] } })
const deferred = () => {
  let resolve!: (response: Response) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Response>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
let AppRouter: typeof import('./router').AppRouter
let posts: Promise<Response>[]
let createCount: number
let postCount: number
let narrow: boolean
let sessionReads: Promise<Response>[]
let events: { onerror?: () => void }[]
let deletes: Promise<Response>[]
let listed: Session[]

beforeEach(async () => {
  // The real service owns module-level state; each router gets a fresh store and subscriptions.
  vi.resetModules()
  posts = []
  createCount = 0
  postCount = 0
  narrow = false
  sessionReads = []
  events = []
  deletes = []
  listed = [session('old'), session('other')]
  window.history.replaceState({}, '', '/workspace')
  localStorage.clear()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: !narrow && query.includes('min-width'),
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      onerror?: () => void
      constructor() {
        super()
        events.push(this)
      }
      close() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/api/me') return Response.json({ id: 'synthetic', name: '测试用户' })
      if (path === '/api/models') return Response.json(catalog)
      if (path === '/api/sessions' && options?.method === 'POST') {
        createCount++
        return Response.json(session(`created-${createCount}`))
      }
      if (path === '/api/sessions') return Response.json(listed)
      if (options?.method === 'DELETE') return deletes.shift() ?? Response.json({})
      if (path.endsWith('/messages')) {
        postCount++
        return posts.shift() ?? Response.json({})
      }
      if (path.startsWith('/api/sessions/'))
        return sessionReads.shift() ?? Response.json(session(path.split('/').at(-1)!))
      throw new Error(`Unexpected request: ${path}`)
    }),
  )
  ;({ AppRouter } = await import('./router'))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function open(path = '/workspace') {
  window.history.replaceState({}, '', path)
  render(
    <StrictMode>
      <AppRouter />
    </StrictMode>,
  )
  await screen.findByRole('textbox', { name: '研究问题' })
  await waitFor(() => expect(screen.queryByText('正在加载会话…')).not.toBeInTheDocument())
}

it('首次发送成功时保留等待期间的新文字和图片，且仅清空已发送内容', async () => {
  const pending = deferred()
  posts.push(pending.promise)
  await open()
  const original = box()
  fireEvent.change(original, { target: { value: '第一条' } })
  attach('已发送.png')
  send()
  await waitFor(() => expect(postCount).toBe(1))
  fireEvent.change(original, { target: { value: '下一条草稿' } })
  attach('待发送.png')
  await act(async () => pending.resolve(Response.json({})))
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/created-1'))
  expect(box()).toBe(original)
  expect(box()).toHaveValue('下一条草稿')
  expect(screen.getByRole('img', { name: '待发送.png' })).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: '已发送.png' })).not.toBeInTheDocument()
  expect(localStorage.length).toBe(0)
})

it('首次发送成功且没有新草稿时清空文字和图片', async () => {
  await open()
  fireEvent.change(box(), { target: { value: '第一条' } })
  attach('已发送.png')
  send()
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/created-1'))
  await waitFor(() => expect(box()).toHaveValue(''))
  expect(screen.queryByRole('list', { name: '待发送图片' })).not.toBeInTheDocument()
})

it.each(['/workspace', '/workspace/old'])(
  '%s 等待确认时重新输入相同问题，新文字和新附图仍属于下一条',
  async (path) => {
    const pending = deferred()
    posts.push(pending.promise)
    await open(path)
    fireEvent.change(box(), { target: { value: '分析这张图' } })
    attach('第一张.png')
    send()
    await waitFor(() => expect(postCount).toBe(1))
    fireEvent.change(box(), { target: { value: '' } })
    fireEvent.change(box(), { target: { value: '分析这张图' } })
    attach('第二张.png')
    await act(async () => pending.resolve(Response.json({})))
    await waitFor(() =>
      expect(window.location.pathname).toBe(path === '/workspace' ? '/workspace/created-1' : path),
    )
    expect(box()).toHaveValue('分析这张图')
    expect(screen.queryByRole('img', { name: '第一张.png' })).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: '第二张.png' })).toBeInTheDocument()
    send()
    await waitFor(() => expect(postCount).toBe(2))
    const requests = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/messages'))
      .map(([, options]) => JSON.parse(String(options?.body)))
    expect(requests.map(({ question }) => question)).toEqual(['分析这张图', '分析这张图'])
    expect(requests.map(({ images }) => images.map(({ name }: { name: string }) => name))).toEqual([
      ['第一张.png'],
      ['第二张.png'],
    ])
    await waitFor(() => expect(box()).toHaveValue(''))
    expect(screen.queryByRole('list', { name: '待发送图片' })).not.toBeInTheDocument()
  },
)

it('首次发送失败保留文字和图片，重试沿用已创建会话', async () => {
  posts.push(Promise.resolve(Response.json({ error: '发送测试失败' }, { status: 503 })))
  await open()
  fireEvent.change(box(), { target: { value: '保留问题' } })
  attach('保留.png')
  send()
  expect(await screen.findByRole('alert')).toHaveTextContent('发送测试失败')
  expect(window.location.pathname).toBe('/workspace')
  expect(box()).toHaveValue('保留问题')
  expect(screen.getByRole('img', { name: '保留.png' })).toBeInTheDocument()
  send()
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/created-1'))
  expect(createCount).toBe(1)
  expect(postCount).toBe(2)
  await waitFor(() => expect(box()).toHaveValue(''))
  expect(screen.queryByText('发送测试失败')).not.toBeInTheDocument()
})

it('首次发送失败后在侧栏删掉刚建的空记录，重试时重新新建会话并保留草稿', async () => {
  posts.push(Promise.resolve(Response.json({ error: '发送测试失败' }, { status: 503 })))
  const user = userEvent.setup()
  await open()
  fireEvent.change(box(), { target: { value: '保留问题' } })
  send()
  expect(await screen.findByRole('alert')).toHaveTextContent('发送测试失败')
  const row = screen.getByRole('link', { name: '研究 created-1' }).closest('li')!
  await user.click(within(row).getByRole('button', { name: '更多操作' }))
  await user.click(await screen.findByRole('menuitem', { name: '删除' }))
  const dialog = await screen.findByRole('alertdialog')
  await user.click(within(dialog).getByRole('button', { name: '删除' }))
  await waitFor(() =>
    expect(screen.queryByRole('link', { name: '研究 created-1' })).not.toBeInTheDocument(),
  )
  expect(box()).toHaveValue('保留问题')
  send()
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/created-2'))
  expect(createCount).toBe(2)
  const asked = vi.mocked(fetch).mock.calls.map(([path]) => String(path))
  expect(asked.filter((path) => path.endsWith('/messages'))).toEqual([
    '/api/sessions/created-1/messages',
    '/api/sessions/created-2/messages',
  ])
})

it('删除等待期间切到别的研究，删除完成后不再强制跳回工作台', async () => {
  const pending = deferred()
  deletes.push(pending.promise)
  const user = userEvent.setup()
  await open('/workspace/old')
  const row = screen.getByRole('link', { name: '研究 old' }).closest('li')!
  await user.click(within(row).getByRole('button', { name: '更多操作' }))
  await user.click(await screen.findByRole('menuitem', { name: '删除' }))
  const dialog = await screen.findByRole('alertdialog')
  await user.click(within(dialog).getByRole('button', { name: '删除' }))
  // 模态框挡住指针，这里直接派发点击，模拟用户在等待期间用浏览器后退等方式离开
  fireEvent.click(screen.getByRole('link', { name: '研究 other', hidden: true }))
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/other'))
  await act(async () => pending.resolve(Response.json({})))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  expect(window.location.pathname).toBe('/workspace/other')
})

it('删除唯一一条记录后，焦点交给“新建研究”', async () => {
  listed = [session('old')]
  const user = userEvent.setup()
  await open('/workspace/old')
  const row = screen.getByRole('link', { name: '研究 old' }).closest('li')!
  await user.click(within(row).getByRole('button', { name: '更多操作' }))
  await user.click(await screen.findByRole('menuitem', { name: '删除' }))
  const dialog = await screen.findByRole('alertdialog')
  await user.click(within(dialog).getByRole('button', { name: '删除' }))
  await waitFor(() => expect(window.location.pathname).toBe('/workspace'))
  await waitFor(() => expect(screen.getByRole('link', { name: '新建研究' })).toHaveFocus())
})

it('已有会话发送时也保留等待期间的新草稿', async () => {
  const pending = deferred()
  posts.push(pending.promise)
  await open('/workspace/old')
  fireEvent.change(box(), { target: { value: '第一条' } })
  send()
  await waitFor(() => expect(postCount).toBe(1))
  fireEvent.change(box(), { target: { value: '下一条' } })
  await act(async () => pending.resolve(Response.json({})))
  expect(box()).toHaveValue('下一条')
  expect(window.location.pathname).toBe('/workspace/old')
})

it('真正切换会话及新建研究重置文字、图片和错误；新建研究打开空白页并聚焦输入框，不预先建会话', async () => {
  posts.push(Promise.resolve(Response.json({ error: '旧会话错误' }, { status: 503 })))
  await open('/workspace/old')
  fireEvent.change(box(), { target: { value: '旧草稿' } })
  attach('旧草稿.png')
  send()
  expect(await screen.findByRole('alert')).toHaveTextContent('旧会话错误')
  fireEvent.click(screen.getByRole('link', { name: '研究 other', hidden: true }))
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/other'))
  await waitFor(() => expect(box()).toHaveValue(''))
  expect(screen.queryByRole('img', { name: '旧草稿.png' })).not.toBeInTheDocument()
  expect(screen.queryByText('旧会话错误')).not.toBeInTheDocument()
  fireEvent.change(box(), { target: { value: '另一个草稿' } })
  fireEvent.click(screen.getByRole('link', { name: '新建研究' }))
  await waitFor(() => expect(window.location.pathname).toBe('/workspace'))
  await waitFor(() => expect(box()).toHaveValue(''))
  await waitFor(() => expect(box()).toHaveFocus())
  // 在空白页再点一次也重置草稿
  fireEvent.change(box(), { target: { value: '空白页草稿' } })
  fireEvent.click(screen.getByRole('link', { name: '新建研究' }))
  await waitFor(() => expect(box()).toHaveValue(''))
  expect(createCount).toBe(0)
})

it('首次自动跳转后，后退和前进均重置草稿，不重放延续标记', async () => {
  await open()
  fireEvent.change(box(), { target: { value: '第一条' } })
  send()
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/created-1'))
  fireEvent.change(box(), { target: { value: '后退前的草稿' } })
  attach('后退前.png')
  await act(async () => window.history.back())
  await waitFor(() => expect(window.location.pathname).toBe('/workspace'))
  await waitFor(() => expect(box()).toHaveValue(''))
  expect(screen.queryByRole('img', { name: '后退前.png' })).not.toBeInTheDocument()
  fireEvent.change(box(), { target: { value: '前进前的草稿' } })
  await act(async () => window.history.forward())
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/created-1'))
  await waitFor(() => expect(box()).toHaveValue(''))
})

it('发送未完成时离开再返回，旧发送不会导航或改写新草稿', async () => {
  const pending = deferred()
  posts.push(pending.promise)
  await open()
  fireEvent.change(box(), { target: { value: '第一条' } })
  send()
  await waitFor(() => expect(postCount).toBe(1))
  fireEvent.click(screen.getByRole('link', { name: '文献库' }))
  fireEvent.click(screen.getByRole('link', { name: '新建研究' }))
  fireEvent.change(box(), { target: { value: '返回后的草稿' } })
  await act(async () => pending.resolve(Response.json({})))
  expect(window.location.pathname).toBe('/workspace')
  expect(box()).toHaveValue('返回后的草稿')
})

it('窄屏在抽屉里点新建研究：关闭抽屉并聚焦输入框，不预先建会话', async () => {
  narrow = true
  await open('/workspace/old')
  fireEvent.click(screen.getByRole('button', { name: '切换侧栏' }))
  fireEvent.click(screen.getByRole('link', { name: '新建研究' }))
  await waitFor(() => expect(window.location.pathname).toBe('/workspace'))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await waitFor(() => expect(box()).toHaveFocus())
  expect(createCount).toBe(0)
})

for (const failure of ['http', 'network']) {
  it(`重连读取${failure === 'http' ? '服务错误' : '网络失败'}后重试保留未发送文字和图片`, async () => {
    await open('/workspace/old')
    const original = box()
    fireEvent.change(original, { target: { value: '重连前的未发送草稿' } })
    attach('重连前.png')
    act(() => events.at(-1)!.onerror?.())
    const pending = deferred()
    sessionReads.push(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    await screen.findByText('正在加载会话…')
    expect(screen.getByRole('button', { name: '发送' })).toHaveAttribute('aria-disabled', 'true')
    await act(async () => {
      if (failure === 'http')
        pending.resolve(Response.json({ error: '重连读取失败' }, { status: 503 }))
      else pending.reject(new TypeError('Failed to fetch'))
    })
    await screen.findByRole('button', { name: '重试加载' })
    expect(original).toBeInTheDocument()
    expect(original).not.toBeVisible()
    expect(original).toHaveValue('重连前的未发送草稿')
    // Even a dispatched submit cannot send while the current session could not be read.
    fireEvent.submit(screen.getByRole('form', { name: '提问', hidden: true }))
    expect(postCount).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }))
    await waitFor(() => expect(screen.queryByText('正在加载会话…')).not.toBeInTheDocument())
    expect(box()).toHaveValue('重连前的未发送草稿')
    expect(box()).toBe(original)
    expect(screen.getByRole('img', { name: '重连前.png' })).toBeInTheDocument()
    expect(postCount).toBe(0)
    expect(window.location.pathname).toBe('/workspace/old')
    expect(localStorage.length).toBe(0)
  })
}
