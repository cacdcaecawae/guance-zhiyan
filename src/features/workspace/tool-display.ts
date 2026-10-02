import type { AssistantMessage } from '@/types'

export const toolNames: Record<string, string> = {
  web_search: '联网搜索',
  library_search: '文献检索',
  library_open: '查看原文',
  web_fetch: '读取网页',
  create_file: '生成文件',
  read_file: '读取文件',
  list_files: '列出文件',
  bash: '执行命令',
  read: '读取工作区文件',
  write: '写入工作区文件',
  edit: '编辑工作区文件',
  export_file: '导出文件',
}
export function toolSummary(input: string): string {
  try {
    const value = JSON.parse(input)
    const summary =
      value.queries?.join(' · ') ??
      value.query ??
      value.command ??
      value.file_path ??
      value.path ??
      value.url ??
      value.name ??
      value.id
    return typeof summary === 'string' ? summary : input
  } catch {
    return input
  }
}

/**
 * 过程与最终回答的分界，adapted from DSH's turn-process boundary; see THIRD_PARTY_NOTICES.
 * 最终回答只从最后一步的正文起算；这一步的思考与此前的思考、工具一样归入过程（DSH 同样随过程折起）。
 */
export function splitAnswer(message: AssistantMessage) {
  const lastTool = message.parts.findLastIndex((part) => part.type === 'tool')
  const lastText = message.parts.findLast((part) => part.type === 'text')
  const finalStart =
    lastText && message.parts.indexOf(lastText) > lastTool
      ? message.parts.findIndex((part) => part.type === 'text' && part.step === lastText.step)
      : message.parts.length
  return { process: message.parts.slice(0, finalStart), final: message.parts.slice(finalStart) }
}
