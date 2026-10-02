export interface User {
  id: string
  name: string
}
export interface Artifact {
  id: string
  sessionId: string
  name: string
  format: string
  size: number
}
export type AnswerPart =
  | { id: string; type: 'text'; text: string; step: number }
  | { id: string; type: 'reasoning'; text: string; step: number }
  | {
      id: string
      type: 'tool'
      name: string
      input: string
      output: string
      status: 'running' | 'done' | 'error' | 'stopped'
    }
export interface ImageAttachment {
  id: string
  name?: string
  width: number
  height: number
}
export interface AssistantMessage {
  id: string
  role: 'assistant'
  question: string
  /** 所答问题附带的图片，重新提问时一并重发 */
  questionImages?: ImageAttachment[]
  status: 'loading' | 'done' | 'error' | 'stopped'
  parts: AnswerPart[]
  error?: string
  /** 本轮开始与结束的时间戳（毫秒），用于执行过程的用时 */
  startedAt?: number
  endedAt?: number
}
export type Message =
  { id: string; role: 'user'; text: string; images?: ImageAttachment[] } | AssistantMessage
export interface SessionSummary {
  id: string
  title: string
  /** 只在会话列表中提供 */
  pinned?: boolean
}
export interface ModelSelection {
  provider: string
  model: string
}
export interface ModelCatalog {
  providers: {
    id: string
    name: string
    configured: boolean
    models: { id: string; name: string }[]
  }[]
  defaultSelection: ModelSelection
}
export interface Session extends SessionSummary, ModelSelection {
  messages: Message[]
  artifacts: Artifact[]
  running: boolean
  trace: TraceEntry[]
}
export interface TraceEntry {
  id: string
  turn: number
  step?: number
  kind: 'system' | 'user' | 'context' | 'assistant' | 'tool'
  label: string
  text: string
  input?: string
  time: number
  end?: number
  status?: 'running' | 'done' | 'error' | 'stopped'
}
