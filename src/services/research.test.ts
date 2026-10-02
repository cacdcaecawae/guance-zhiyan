import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  askQuestion,
  createSession,
  deleteSession,
  updateSession,
  useResearch,
  watchSession,
} from './research'
import type { Session } from '@/types'

it('会话切换丢弃过时读取；HTTP 确认不覆盖较新的流式状态', async () => {
  const pending = new Map<string, (response: Response) => void>()
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => new Promise<Response>((resolve) => pending.set(path, resolve))),
  )
  class TestEvents extends EventTarget {
    static instances: TestEvents[] = []
    onmessage?: (event: MessageEvent) => void
    onerror?: () => void
    close = vi.fn()
    constructor() {
      super()
      TestEvents.instances.push(this)
    }
  }
  vi.stubGlobal('EventSource', TestEvents)
  const { result, unmount } = renderHook(useResearch)
  const session = (id: string, title: string): Session => ({
    id,
    title,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    messages: [],
    artifacts: [],
    trace: [],
    running: false,
  })
  let stopOld = () => {}
  let stopNew = () => {}
  try {
    act(() => {
      stopOld = watchSession('old')
    })
    act(() => {
      stopOld()
      stopNew = watchSession('new')
    })
    await act(async () => {
      pending.get('/api/sessions/new')!(Response.json(session('new', '新会话')))
    })
    await act(async () => {
      pending.get('/api/sessions/old')!(Response.json(session('old', '旧会话')))
    })
    expect(result.current.current?.title).toBe('新会话')
    expect(TestEvents.instances).toHaveLength(1)
    const source = TestEvents.instances[0]
    const post = askQuestion('new', '问题')
    act(() => {
      source.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ snapshot: session('new', '最新回答') }),
        }),
      )
    })
    // 提问先编码图片再发出请求
    await vi.waitFor(() => expect(pending.has('/api/sessions/new/messages')).toBe(true))
    await act(async () => {
      pending.get('/api/sessions/new/messages')!(Response.json(session('new', '过时确认')))
      await post
    })
    expect(result.current.current?.title).toBe('最新回答')
    act(() => {
      source.onerror?.()
    })
    expect(result.current.connectionError).toContain('尚未确认')
    expect(result.current.current?.title).toBe('最新回答')
  } finally {
    act(() => {
      stopNew()
    })
    unmount()
    vi.unstubAllGlobals()
  }
})

it('网络不通时给出中文错误，而不是浏览器的英文原文', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
  await expect(createSession()).rejects.toThrow('网络连接失败，请检查网络后重试。')
  vi.unstubAllGlobals()
})

it('重新提问只传本会话已存图片的 id，不下载原图再上传', async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({}))
  vi.stubGlobal('fetch', fetch)
  try {
    await askQuestion('s1', '', undefined, [
      { id: 'sha256:1', name: '表格.png', width: 1, height: 1 },
    ])
    expect(fetch).toHaveBeenCalledOnce()
    const [path, init] = fetch.mock.calls[0]
    expect(path).toBe('/api/sessions/s1/messages')
    expect(JSON.parse(String(init?.body))).toEqual({ question: '', images: [{ id: 'sha256:1' }] })
  } finally {
    vi.unstubAllGlobals()
  }
})

it('删除：会话已删但清理失败时返回提示；会话仍在时报错并以服务端列表为准', async () => {
  // 模拟服务端：kept 的容器无法回收，会话保留；gone 的记录已删但文件清理失败
  const server = ['gone', 'kept']
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ id: server.shift(), title: '新研究' })
      if (path === '/api/sessions') return Response.json([{ id: 'kept', title: '新研究' }])
      if (path === '/api/sessions/kept')
        return init?.method === 'DELETE'
          ? Response.json({ error: '沙箱容器暂时无法回收' }, { status: 503 })
          : Response.json({})
      return init?.method === 'DELETE'
        ? Response.json({ error: '会话已删除，但未能完全清理' }, { status: 500 })
        : Response.json({ error: '没有找到会话。' }, { status: 404 })
    }),
  )
  const { result, unmount } = renderHook(useResearch)
  try {
    await act(() => createSession())
    await act(() => createSession())
    await act(() => expect(deleteSession('kept')).rejects.toThrow('沙箱容器暂时无法回收'))
    expect(result.current.sessions.map((s) => s.id)).toEqual(['kept'])
    await act(async () => expect(await deleteSession('gone')).toMatch('未能完全清理'))
    expect(result.current.sessions.map((s) => s.id)).toEqual(['kept'])
  } finally {
    unmount()
    vi.unstubAllGlobals()
  }
})

it('置顶后的列表读取迟于其他会话的删除时，丢弃过时列表并重读', async () => {
  const lists: ((response: Response) => void)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/sessions' && !init?.method)
        return new Promise<Response>((resolve) => lists.push(resolve))
      if (init?.method === 'PATCH')
        return Promise.resolve(Response.json({ id: 'pin', title: '置顶', pinned: true }))
      if (init?.method === 'POST')
        return Promise.resolve(Response.json({ id: 'removed', title: '删除' }))
      return Promise.resolve(Response.json({}))
    }),
  )
  const { result, unmount } = renderHook(useResearch)
  try {
    await act(() => createSession())
    let pinned!: Promise<void>
    act(() => {
      pinned = updateSession('pin', { pinned: true })
    })
    await waitFor(() => expect(lists).toHaveLength(1))
    await act(() => deleteSession('removed'))
    expect(result.current.sessions.some((s) => s.id === 'removed')).toBe(false)
    // 删除之前服务端给出的列表仍含已删会话，迟到后不能覆盖
    act(() => lists[0](Response.json([{ id: 'removed', title: '删除' }])))
    await waitFor(() => expect(lists).toHaveLength(2))
    expect(result.current.sessions.some((s) => s.id === 'removed')).toBe(false)
    act(() => lists[1](Response.json([{ id: 'pin', title: '置顶', pinned: true }])))
    await act(() => pinned)
    expect(result.current.sessions).toEqual([{ id: 'pin', title: '置顶', pinned: true }])
  } finally {
    unmount()
    vi.unstubAllGlobals()
  }
})

it('同一会话连续重命名按提交顺序发送，后提交的标题不被先提交的迟到响应覆盖', async () => {
  const patches: { title: string; resolve: (response: Response) => void }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_path: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return Promise.resolve(Response.json({ id: 'order', title: '原名' }))
      const { title } = JSON.parse(String(init?.body)) as { title: string }
      return new Promise<Response>((resolve) => patches.push({ title, resolve }))
    }),
  )
  const { result, unmount } = renderHook(useResearch)
  const title = () => result.current.sessions.find((s) => s.id === 'order')?.title
  try {
    await act(() => createSession())
    let first!: Promise<void>, second!: Promise<void>
    act(() => {
      first = updateSession('order', { title: '甲' })
      second = updateSession('order', { title: '乙' })
    })
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].title).toBe('甲')
    act(() => patches[0].resolve(Response.json({ id: 'order', title: '甲', pinned: false })))
    await act(() => first)
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(title()).toBe('甲')
    act(() => patches[1].resolve(Response.json({ id: 'order', title: '乙', pinned: false })))
    await act(() => second)
    expect(title()).toBe('乙')
  } finally {
    unmount()
    vi.unstubAllGlobals()
  }
})
