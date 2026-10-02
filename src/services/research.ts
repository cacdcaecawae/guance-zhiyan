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

const reloadSessions = async () => update({ sessions: await request('/sessions') })

export async function updateSession(id: string, patch: { title?: string; pinned?: boolean }) {
  const session = await request<SessionSummary>(`/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  update({ current: state.current?.id === id ? { ...state.current, ...session } : state.current })
  // 置顶改变排序，以服务端列表为准
  if (patch.pinned === undefined)
    update({ sessions: state.sessions.map((s) => (s.id === id ? session : s)) })
  else await reloadSessions()
}

export async function deleteSession(id: string) {
  try {
    await request(`/sessions/${id}`, { method: 'DELETE' })
  } catch (error) {
    // 清理失败时会话记录可能已删除，以服务端列表为准
    await reloadSessions().catch(() => {})
    throw error
  }
  update({ sessions: state.sessions.filter((s) => s.id !== id) })
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
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title: session.title } : s)),
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
