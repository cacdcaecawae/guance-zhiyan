import { useSyncExternalStore } from 'react'
import type {
  Artifact,
  ImageAttachment,
  ModelCatalog,
  ModelSelection,
  Session,
  SessionSummary,
  User,
} from '@/types'
import { applySessionFrame, type SessionFrame } from './session-stream'

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

// 网络不通时 fetch 与读取正文都会抛出英文 TypeError（如 Failed to fetch），统一换成可读的中文；主动取消的请求原样抛出
const offline =
  (signal?: AbortSignal | null) =>
  (error: unknown): never => {
    if (signal?.aborted) throw error
    throw new Error('网络连接失败，请检查网络后重试。')
  }
const send = (url: string, init?: RequestInit) => fetch(url, init).catch(offline(init?.signal))

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await send(`/api${path}`, {
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
    listVersion++
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

// 本地每次改动会话列表都使进行中的列表读取过时：过时结果丢弃并重读，不覆盖较新的改动
let listVersion = 0
function setSessions(sessions: SessionSummary[]) {
  listVersion++
  update({ sessions })
}
async function reloadSessions() {
  for (;;) {
    const version = listVersion
    const sessions = await request<SessionSummary[]>('/sessions')
    if (version === listVersion) return update({ sessions })
  }
}

// 同一会话的修改按提交顺序依次发送，后提交的结果不会被先提交的迟到响应覆盖
const queues = new Map<string, Promise<void>>()
function inOrder<T>(id: string, task: () => Promise<T>) {
  const result = (queues.get(id) ?? Promise.resolve()).then(task)
  const settled = result.then(
    () => {},
    () => {},
  )
  queues.set(id, settled)
  void settled.then(() => {
    if (queues.get(id) === settled) queues.delete(id)
  })
  return result
}

// 本页删除过的会话：迟到的新建确认不能把它恢复到列表
const deleted = new Set<string>()

export async function createSession() {
  const session = await request<SessionSummary>('/sessions', { method: 'POST' })
  // 确认到达前这条记录已从侧栏删除：不再插回，交给调用方重新新建
  if (deleted.has(session.id)) throw new Error('该研究记录已删除，请重新发送。')
  // 并发列表刷新可能已包含新会话；保留该条记录及服务端排序。
  setSessions(
    state.sessions.some((item) => item.id === session.id)
      ? state.sessions
      : [session, ...state.sessions],
  )
  return session
}

export const updateSession = (id: string, patch: { title?: string; pinned?: boolean }) =>
  inOrder(id, async () => {
    const session = await request<SessionSummary>(`/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    // 当前会话的标题由实时流送达（服务端已通知），这里只改列表：两处都写会让增量追加重复叠加
    // 置顶改变排序，以服务端列表为准
    if (patch.pinned === undefined)
      setSessions(state.sessions.map((s) => (s.id === id ? session : s)))
    else {
      listVersion++
      await reloadSessions()
    }
  })

/**
 * 删除成功时返回 undefined；会话已删除但服务端未能完全清理时返回其提示；会话仍在时抛出错误。
 */
export const deleteSession = (id: string) =>
  inOrder(id, async () => {
    try {
      await request(`/sessions/${id}`, { method: 'DELETE' })
    } catch (error) {
      // 清理失败时会话可能已删除：以服务端能否读到该会话为准
      const gone = await send(`/api/sessions/${id}`, { credentials: 'same-origin' }).then(
        (response) => response.status === 404,
        () => false,
      )
      if (!gone) {
        await reloadSessions().catch(() => {})
        throw error
      }
      deleted.add(id)
      setSessions(state.sessions.filter((s) => s.id !== id))
      return error instanceof Error ? error.message : '会话已删除，但未能完全清理。'
    }
    deleted.add(id)
    setSessions(state.sessions.filter((s) => s.id !== id))
  })

/** A single subscription owns the visible session. Route changes invalidate old reads. */
export function watchSession(id?: string) {
  const version = ++generation
  const abort = new AbortController()
  let source: EventSource | undefined
  update({ current: null, loading: !!id, error: null, connectionError: null })
  const apply = (session: Session) => {
    if (version !== generation) return
    // 标题变化也算列表改动，使进行中的列表读取过时
    const renamed = state.sessions.some((s) => s.id === id && s.title !== session.title)
    if (renamed) listVersion++
    update({
      current: session,
      loading: false,
      error: null,
      connectionError: null,
      ...(renamed && {
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, title: session.title } : s)),
      }),
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
            apply(applySessionFrame(state.current, JSON.parse(event.data) as SessionFrame))
          } catch {
            update({ connectionError: '无法读取执行状态，请重新连接。' })
            source?.close()
          }
        }
        source.onerror = () => {
          if (version === generation)
            update({ connectionError: '连接已中断，正在重新连接；生成状态尚未确认。' })
        }
        source.addEventListener('deleted', () => {
          if (version === generation) update({ error: '该研究记录已删除。', connectionError: null })
          source?.close()
        })
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

export const imageUrl = (sessionId: string, image: Pick<ImageAttachment, 'id'>) =>
  `/api/sessions/${sessionId}/images/${encodeURIComponent(image.id)}`

/** 新图片以 base64 随问题提交；重新提问时只传本会话已存图片的 id，由后端核对归属后复用，不重新上传。 */
async function encodeImage(image: Blob | ImageAttachment) {
  if (!(image instanceof Blob)) return { id: image.id }
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^[^,]*,/, ''))
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'))
    reader.readAsDataURL(image)
  })
  return {
    mediaType: image.type,
    data,
    ...(image instanceof File && image.name && { name: image.name }),
  }
}

// POST acknowledgements never overwrite a newer stream snapshot.
export const askQuestion = async (
  id: string,
  question: string,
  selection?: ModelSelection,
  images: (Blob | ImageAttachment)[] = [],
) =>
  request(`/sessions/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      question,
      selection,
      images: await Promise.all(images.map(encodeImage)),
    }),
  })
export const stopAnswer = (id: string) => request(`/sessions/${id}/stop`, { method: 'POST' })
export const artifactUrl = (file: Pick<Artifact, 'id'>) =>
  `/api/files/${encodeURIComponent(file.id)}`

/** 读取会话文件的文本内容，供右侧预览使用；只对文本格式调用。 */
export async function readArtifactText(file: Pick<Artifact, 'id'>, signal?: AbortSignal) {
  const response = await send(artifactUrl(file), { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`文件读取失败（${response.status}），请重试。`)
  return response.text().catch(offline(signal))
}
