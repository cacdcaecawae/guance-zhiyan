import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

it('列表刷新先于创建确认时，会话只出现一次且保留服务端顺序', async () => {
  vi.resetModules()
  const service = await import('./research')
  let resolve!: (response: Response) => void
  const created = new Promise<Response>((done) => {
    resolve = done
  })
  const fresh = { id: 'new-fixture', title: '新研究', pinned: false }
  const pinned = { id: 'pin-fixture', title: '已有研究', pinned: true }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return created
      if (init?.method === 'PATCH') return Response.json(pinned)
      if (path === '/api/sessions') return Response.json([pinned, fresh])
      throw new Error('Unexpected request')
    }),
  )
  const { result, unmount } = renderHook(service.useResearch)
  try {
    // 服务端已创建会话，但 POST 确认尚未到达。
    const creating = service.createSession()
    // 同时置顶另一条记录，列表刷新先读到了新会话。
    await act(() => service.updateSession(pinned.id, { pinned: true }))
    expect(result.current.sessions.filter((s) => s.id === fresh.id)).toHaveLength(1)
    await act(async () => {
      resolve(Response.json(fresh))
      await creating
    })
    expect(result.current.sessions.filter((s) => s.id === fresh.id)).toHaveLength(1)
    expect(result.current.sessions).toEqual([pinned, fresh])
  } finally {
    unmount()
    vi.unstubAllGlobals()
  }
})
