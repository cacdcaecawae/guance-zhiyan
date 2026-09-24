export interface User {
  id: string
  name: string
}
export interface Artifact {
  id: string
  sessionId: string
  name: string
  format: 'md' | 'docx' | 'xlsx' | 'csv'
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
      status: 'running' | 'done' | 'error'
    }
export interface AssistantMessage {
  id: string
  role: 'assistant'
  question: string
  status: 'loading' | 'done' | 'error' | 'stopped'
  parts: AnswerPart[]
  error?: string
}
export type Message = { id: string; role: 'user'; text: string } | AssistantMessage
export interface SessionSummary {
  id: string
  title: string
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
