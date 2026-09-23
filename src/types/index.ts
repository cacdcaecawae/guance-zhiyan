/** 当前界面实际用到的共享类型，接口名与 CONTEXT.md 的术语对应。接入真实数据时按接口补充或调整，不为未实现功能预留字段。 */

/** 文献 */
export interface Document {
  id: string
  title: string
  /** 来源说明，演示阶段固定为虚构标注 */
  source: string
}

/** 片段 */
export interface Passage {
  id: string
  documentId: string
  section: string
  /** 片段在文献中的编号 */
  index: number
  text: string
  /** text 中需要高亮的子串 */
  highlight: string
}

/** 引用 */
export interface Citation {
  id: string
  /** 回答文本中的角标序号，对应 `[n]` */
  marker: number
  passageId: string
}

/** 问题 */
export interface UserMessage {
  id: string
  role: 'user'
  text: string
}

export type AnswerStatus = 'loading' | 'done' | 'empty' | 'error'

/** 回答 */
export interface AssistantMessage {
  id: string
  role: 'assistant'
  status: AnswerStatus
  /** 发起本条回答的问题，用于重试 */
  question: string
  /** 回答正文，内含 `[n]` 引用角标 */
  text: string
  citations: Citation[]
  error?: string
}

export type Message = UserMessage | AssistantMessage

/** 会话 */
export interface Session {
  id: string
  title: string
  messages: Message[]
}

/** 数据源返回的回答载荷（不含界面状态） */
export interface AnswerPayload {
  text: string
  citations: Citation[]
}
