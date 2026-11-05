export interface User {
  id: string
  name: string
  /** 服务器模式下经账号登录，可以退出 */
  login?: boolean
}
export interface Artifact {
  id: string
  sessionId: string
  name: string
  format: string
  size: number
  /** 系统生成的 Office 文件保留了生成时的原文，可在线预览 */
  preview?: boolean
}
/** Office 文件的预览：Word 为 Markdown，Excel 为 CSV，演示文稿为与导出文件同一套分页（JSON 的 SlidePlan[]）；
 * 早先生成的演示文稿保留的是 Markdown */
export interface ArtifactPreview {
  kind: 'markdown' | 'csv' | 'slides'
  text: string
}
/** 演示文稿里的一段文字；sup 为引用编号 */
export interface SlideSeg {
  text: string
  bold?: boolean
  italics?: boolean
  strike?: boolean
  link?: string
  sup?: boolean
}
/** 演示文稿一页的正文，版式按内容形态选用（DESIGN.md“生成文件版式”） */
export type SlideBody =
  | { layout: 'rows'; rows: { label: SlideSeg[]; body: SlideSeg[] }[] }
  | { layout: 'cards'; rows: { label: SlideSeg[]; body: SlideSeg[] }[] }
  | {
      layout: 'bullets' | 'sources'
      /** bullet：true 为项目符号，数字为有序编号 */
      lines: { segs: SlideSeg[]; level: number; bullet?: true | number }[]
    }
  | {
      layout: 'table'
      rows: string[][]
      colW: number[]
      align: ('left' | 'right' | 'center' | null)[]
    }
/** 演示文稿的一页：封面，或带页标题的正文页；lead 为正文上方的引导语（如表格前的一两句、小节前的“四个方面：”），
 * notes 为页底注，foot 为本页来源脚注 */
export type SlidePlan =
  | { layout: 'cover'; title: string; subtitle: string; lines: SlideSeg[][] }
  | ({
      kicker: string
      title: string
      lead?: SlideSeg[][]
      notes: SlideSeg[][]
      foot: string
    } & SlideBody)
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
  /** 当前生成尝试的标识；重新生成时回答位置不变，但旧请求不能再次提交。 */
  attemptId?: string
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
export interface LibraryDocumentSummary {
  id: string
  title: string
  sourceUrl: string | null
  publishedAt: string | null
}
/** 文献的现行版本，片段按原文顺序排列 */
export interface LibraryDocument extends LibraryDocumentSummary {
  versionId: string
  passages: { id: string; ordinal: number; heading: string; text: string }[]
}
/** 回答引用的原文片段；文献更新后旧引用仍可读，标明已被替代 */
export interface LibraryPassage {
  id: string
  documentId: string
  title: string
  heading: string
  text: string
  ordinal: number
  sourceUrl: string | null
  publishedAt: string | null
  superseded: boolean
}
/** 按内容检索命中的片段（与模型检索同一套混合检索，按相关度排序） */
export interface LibraryHit {
  id: string
  documentId: string
  title: string
  heading: string
  text: string
  ordinal: number
}
