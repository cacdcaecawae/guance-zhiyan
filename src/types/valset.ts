/** 验证集单题结果，原样写入导出表的“状态”列 */
export type ValsetStatus = '正常' | '超时' | '失败' | '已取消'
export interface ValsetRow {
  question: string
  /** 尚未执行或执行中时没有 */
  status?: ValsetStatus
  running?: boolean
  seconds?: number
  /** 本题的独立会话，可查看带引用的完整回答 */
  sessionId?: string
  error?: string
}
export interface ValsetJobSummary {
  id: string
  /** 上传的文件名 */
  name: string
  createdAt: number
  state: 'running' | 'done' | 'cancelled'
  total: number
  finished: number
}
export interface ValsetJob extends ValsetJobSummary {
  /** 平台 / 模型 */
  model: string
  rows: ValsetRow[]
}
