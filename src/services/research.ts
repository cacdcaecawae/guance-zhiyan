import { useSyncExternalStore } from 'react'
import type { Artifact, ModelCatalog, ModelSelection, Session, SessionSummary, User } from '@/types'

interface State {
  user: User | null
  catalog: ModelCatalog | null
  sessions: SessionSummary[]
  current: Session | null
  loading: boolean
  error: string | null
  connectionError: string | null
}
let state: State = {
  user: null,
  catalog: null,
  sessions: [],
  current: null,
  loading: true,
  error: null,
  connectionError: null,
}
const listeners = new Set<() => void>()
let generation = 0
let initialization = 0
function update(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const useResearch = () => useSyncExternalStore(subscribe, () => state)

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const value = await response.json().catch(() => null)
  if (!response.ok) throw new Error(value?.error ?? `请求失败（${response.status}），请重试。`)
  if (value === null) throw new Error('服务器返回了无效数据。')
  return value as T
}

export async function initialize() {
  const version = ++initialization
  update({ loading: true, error: null })
  try {
    const user = await request<User>('/me')
    const sessions = await request<SessionSummary[]>('/sessions')
    const catalog = await request<ModelCatalog>('/models')
    if (version !== initialization) return
    update({ user, catalog, sessions, current: null, loading: false })
  } catch (error) {
    if (version === initialization)
      update({
        user: null,
        catalog: null,
        sessions: [],
        current: null,
        loading: false,
        error: error instanceof Error ? error.message : '连接失败，请重试。',
      })
  }
}

export async function createSession() {
  const session = await request<SessionSummary>('/sessions', { method: 'POST' })
  update({ sessions: [session, ...state.sessions] })
  return session
}

/** A single subscription owns the visible session. Route changes invalidate old reads. */
export function watchSession(id?: string) {
  const version = ++generation
  const abort = new AbortController()
  let source: EventSource | undefined
  update({ current: null, loading: !!id, error: null, connectionError: null })
  const apply = (session: Session) => {
    if (version !== generation) return
    update({
      current: session,
      loading: false,
      error: null,
      connectionError: null,
      sessions: state.sessions.map((s) => (s.id === id ? { id: s.id, title: session.title } : s)),
    })
  }
  if (id)
    void request<Session>(`/sessions/${id}`, { signal: abort.signal })
      .then((session) => {
        if (version !== generation) return
        apply(session)
        source = new EventSource(`/api/sessions/${id}/events`)
        source.onmessage = (event) => {
          if (version !== generation) return
          try {
            apply(JSON.parse(event.data) as Session)
          } catch {
            update({ connectionError: '无法读取执行状态，请重新连接。' })
            source?.close()
          }
        }
        source.onerror = () => {
          if (version === generation)
            update({ connectionError: '连接已中断，正在重新连接；生成状态尚未确认。' })
        }
        source.addEventListener('failure', () => {
          if (version === generation) update({ connectionError: '执行状态读取失败，请重新连接。' })
          source?.close()
        })
      })
      .catch((error) => {
        if (version === generation && !abort.signal.aborted)
          update({
            loading: false,
            error: error instanceof Error ? error.message : '会话加载失败。',
          })
      })
  return () => {
    if (version === generation) generation++
    abort.abort()
    source?.close()
  }
}

// POST acknowledgements never overwrite a newer stream snapshot.
export const askQuestion = (id: string, question: string, selection?: ModelSelection) =>
  request(`/sessions/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ question, selection }),
  })
export const stopAnswer = (id: string) => request(`/sessions/${id}/stop`, { method: 'POST' })
export const artifactUrl = (file: Artifact) => `/api/files/${encodeURIComponent(file.id)}`
