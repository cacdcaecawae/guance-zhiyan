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
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'reasoning'; text: string }
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
export interface Session extends SessionSummary {
  messages: Message[]
  artifacts: Artifact[]
  running: boolean
}
