import type { AnswerPart, AssistantMessage } from '@/types'

export const toolNames: Record<string, string> = {
  web_search: '搜索网页',
  library_search: '文献检索',
  library_open: '查看原文',
  web_fetch: '访问网页',
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

type Tool = Extract<AnswerPart, { type: 'tool' }>
export type Activity =
  | 'thinking'
  | 'read'
  | 'write'
  | 'edit'
  | 'commands'
  | 'webSearch'
  | 'webFetch'
  | 'library'
  | 'file'
  | 'tools'

/** 按工具名分类，adapted from DSH conversation-nodes/README 的工具名分类；另加本项目的文献检索与生成文件。 */
function activityOf(name: string): Exclude<Activity, 'thinking'> {
  if (name === 'read' || name === 'read_file' || name === 'list_files') return 'read'
  if (name === 'write') return 'write'
  if (name === 'edit' || name === 'apply_patch') return 'edit'
  if (name === 'bash') return 'commands'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (name.startsWith('library_')) return 'library'
  if (name === 'create_file' || name === 'export_file') return 'file'
  return 'tools'
}

const runningLabels: Record<Activity, string> = {
  thinking: '正在分析请求',
  read: '正在读取文件',
  write: '正在写入文件',
  edit: '正在编辑文件',
  commands: '正在运行命令',
  webSearch: '正在搜索网页',
  webFetch: '正在访问网页',
  library: '正在检索文献库',
  file: '正在生成文件',
  tools: '正在调用工具',
}
const doneLabels: Record<Activity, string> = {
  thinking: '已完成分析',
  read: '已读取文件',
  write: '已写入文件',
  edit: '修改了文件',
  commands: '执行了命令',
  webSearch: '已搜索网页',
  webFetch: '已访问网页',
  library: '已检索文献库',
  file: '已生成文件',
  tools: '已调用工具',
}

export type ProcessItem =
  | { kind: 'group'; key: string; parts: AnswerPart[]; activity: Activity; title: string }
  | { kind: 'reply'; part: Extract<AnswerPart, { type: 'text' }> }

function group(parts: AnswerPart[], closed: boolean, key: string): ProcessItem {
  const tools = parts.filter((part): part is Tool => part.type === 'tool')
  if (!closed) {
    // 未结束的组写正在运行的工具及其参数；没有运行工具时写“正在分析请求”
    // ponytail: 取成员顺序中最后一个运行中的工具；DSH 按调用开始时间取最新，要更准时给工具补开始时间
    const live = tools.findLast((tool) => tool.status === 'running')
    if (!live)
      return { kind: 'group', key, parts, activity: 'thinking', title: runningLabels.thinking }
    const activity = activityOf(live.name)
    return {
      kind: 'group',
      key,
      parts,
      activity,
      title: `${runningLabels[activity]} · ${toolSummary(live.input)}`,
    }
  }
  // 已结束的组按次数取前三类、不写次数；同次数按首次出现排序（Map 保留插入顺序，sort 稳定）
  const counts = new Map<Exclude<Activity, 'thinking'>, number>()
  for (const tool of tools)
    counts.set(activityOf(tool.name), (counts.get(activityOf(tool.name)) ?? 0) + 1)
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([activity]) => activity)
  const labels = ranked.slice(0, 3).map((activity) => doneLabels[activity])
  const title =
    labels.length === 0
      ? doneLabels.thinking
      : labels.length === 2
        ? `${labels[0]}并${labels[0].startsWith('已') && labels[1].startsWith('已') ? labels[1].slice(1) : labels[1]}`
        : labels.join('，') + (ranked.length > 3 ? '等' : '')
  return { kind: 'group', key, parts, activity: ranked[0] ?? 'thinking', title }
}

/**
 * 过程分组，adapted from DSH conversation-nodes/process-groups 与 process-activity：
 * 相邻的思考与工具成一组，阶段回复把组切开并单独排列；tailClosed 表示末组已结束（轮次结束或其后已有回复）。
 * 过程按事件顺序追加，组序位跨实时流与持久快照稳定；片段 id 会在提交时改变，不能作为组 key。
 * 若以后支持重排旧过程，须改用稳定的组标识。
 */
export function processItems(process: AnswerPart[], tailClosed: boolean): ProcessItem[] {
  const items: ProcessItem[] = []
  let members: AnswerPart[] = []
  for (const part of process) {
    if (part.type !== 'text') {
      members.push(part)
      continue
    }
    if (members.length) items.push(group(members, true, `group-${items.length}`))
    members = []
    items.push({ kind: 'reply', part })
  }
  if (members.length) items.push(group(members, tailClosed, `group-${items.length}`))
  return items
}
