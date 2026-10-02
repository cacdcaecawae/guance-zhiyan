import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { askQuestion, createSession, deleteSession, useResearch, watchSession } from './research'
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

it('删除时清理失败：报告错误，会话列表以服务端为准', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ id: 'gone', title: '新研究' })
      if (init?.method === 'DELETE')
        return Response.json(
          { error: '会话已删除，但未能完全清理，请联系管理员。' },
          { status: 500 },
        )
      return Response.json(path === '/api/sessions' ? [] : {})
    }),
  )
  const { result, unmount } = renderHook(useResearch)
  try {
    await act(() => createSession())
    expect(result.current.sessions.some((s) => s.id === 'gone')).toBe(true)
    await act(() => expect(deleteSession('gone')).rejects.toThrow('未能完全清理'))
    expect(result.current.sessions.some((s) => s.id === 'gone')).toBe(false)
  } finally {
    unmount()
    vi.unstubAllGlobals()
  }
})
