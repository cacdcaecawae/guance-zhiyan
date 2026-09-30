import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  const promise = new Promise<Response>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let AppRouter: typeof import('./router').AppRouter
let creates: Promise<Response>[]
let posts: Promise<Response>[]
let createCount: number
let postCount: number
let narrow: boolean

beforeEach(async () => {
  // The real service owns module-level state; each router gets a fresh store and subscriptions.
  vi.resetModules()
  creates = []
  posts = []
  createCount = 0
  postCount = 0
  narrow = false
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
        return creates.shift() ?? Response.json(session(`created-${createCount}`))
      }
      if (path === '/api/sessions') return Response.json([session('old'), session('other')])
      if (path.endsWith('/messages')) {
        postCount++
        return posts.shift() ?? Response.json({})
      }
      if (path.startsWith('/api/sessions/')) return Response.json(session(path.split('/').at(-1)!))
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

it('真正切换会话及新建研究重置文字、图片和错误，新建后聚焦输入框', async () => {
  posts.push(Promise.resolve(Response.json({ error: '旧会话错误' }, { status: 503 })))
  await open('/workspace/old')
  fireEvent.change(box(), { target: { value: '旧草稿' } })
  attach('旧草稿.png')
  send()
  expect(await screen.findByRole('alert')).toHaveTextContent('旧会话错误')
  fireEvent.click(screen.getByRole('link', { name: '研究 other' }))
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/other'))
  await waitFor(() => expect(box()).toHaveValue(''))
  expect(screen.queryByRole('img', { name: '旧草稿.png' })).not.toBeInTheDocument()
  expect(screen.queryByText('旧会话错误')).not.toBeInTheDocument()
  fireEvent.change(box(), { target: { value: '另一个草稿' } })
  fireEvent.click(screen.getByRole('button', { name: '新建研究' }))
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/created-1'))
  await waitFor(() => expect(box()).toHaveValue(''))
  await waitFor(() => expect(box()).toHaveFocus())
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
  fireEvent.click(screen.getByRole('link', { name: '研究工作台' }))
  fireEvent.change(box(), { target: { value: '返回后的草稿' } })
  await act(async () => pending.resolve(Response.json({})))
  expect(window.location.pathname).toBe('/workspace')
  expect(box()).toHaveValue('返回后的草稿')
})

for (const target of ['文献库', '研究 other']) {
  it(`新建研究的延迟成功不覆盖后来的导航：${target}`, async () => {
    const pending = deferred()
    creates.push(pending.promise)
    await open()
    fireEvent.click(screen.getByRole('button', { name: '新建研究' }))
    await waitFor(() => expect(createCount).toBe(1))
    fireEvent.click(screen.getByRole('link', { name: target }))
    const path = window.location.pathname
    await act(async () => pending.resolve(Response.json(session('delayed'))))
    expect(window.location.pathname).toBe(path)
    expect(screen.getByRole('link', { name: '研究 delayed' })).toBeInTheDocument()
  })
}

it('离开再返回同一地址后，旧新建请求失败不显示错误或解锁较新的请求', async () => {
  const stale = deferred()
  const latest = deferred()
  creates.push(stale.promise, latest.promise)
  await open()
  fireEvent.click(screen.getByRole('button', { name: '新建研究' }))
  fireEvent.click(screen.getByRole('link', { name: '文献库' }))
  fireEvent.click(screen.getByRole('link', { name: '研究工作台' }))
  const button = screen.getByRole('button', { name: '新建研究' })
  expect(button).toHaveAttribute('aria-disabled', 'false')
  fireEvent.click(button)
  await waitFor(() => expect(createCount).toBe(2))
  await act(async () => stale.resolve(Response.json({ error: '过期错误' }, { status: 503 })))
  expect(window.location.pathname).toBe('/workspace')
  expect(screen.queryByText('过期错误')).not.toBeInTheDocument()
  expect(button).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(button)
  expect(createCount).toBe(2)
  await act(async () => latest.resolve(Response.json(session('latest'))))
  expect(window.location.pathname).toBe('/workspace/latest')
  await waitFor(() => expect(box()).toHaveFocus())
})

it('后退至同一地址也使旧新建请求失效', async () => {
  const pending = deferred()
  creates.push(pending.promise)
  await open()
  fireEvent.click(screen.getByRole('button', { name: '新建研究' }))
  fireEvent.click(screen.getByRole('link', { name: '文献库' }))
  await act(async () => window.history.back())
  await waitFor(() => expect(window.location.pathname).toBe('/workspace'))
  await act(async () => pending.resolve(Response.json(session('stale'))))
  expect(window.location.pathname).toBe('/workspace')
})

it('新建失败允许重试，正常成功后聚焦输入框', async () => {
  creates.push(Promise.resolve(Response.json({ error: '新建测试失败' }, { status: 503 })))
  await open()
  const button = screen.getByRole('button', { name: '新建研究' })
  fireEvent.click(button)
  await screen.findByText('新建测试失败')
  expect(button).toHaveAttribute('aria-disabled', 'false')
  fireEvent.click(button)
  await waitFor(() => expect(window.location.pathname).toBe('/workspace/created-2'))
  expect(screen.queryByText('新建测试失败')).not.toBeInTheDocument()
  await waitFor(() => expect(box()).toHaveFocus())
})

it('窄屏关闭导航抽屉后，延迟新建完成不会跳转或重新打开抽屉', async () => {
  narrow = true
  const pending = deferred()
  creates.push(pending.promise)
  await open()
  fireEvent.click(screen.getByRole('button', { name: '切换侧栏' }))
  fireEvent.click(screen.getByRole('button', { name: '新建研究' }))
  await waitFor(() => expect(createCount).toBe(1))
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  await act(async () => pending.resolve(Response.json(session('stale'))))
  expect(window.location.pathname).toBe('/workspace')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '切换侧栏' }))
  expect(screen.getByRole('button', { name: '新建研究' })).toHaveAttribute('aria-disabled', 'false')
  expect(screen.getByRole('link', { name: '研究 stale' })).toBeInTheDocument()
})
