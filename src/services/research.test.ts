import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { askQuestion, useResearch, watchSession } from './research'
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
        new MessageEvent('message', { data: JSON.stringify(session('new', '最新回答')) }),
      )
    })
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
