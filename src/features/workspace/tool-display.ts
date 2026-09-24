export const toolNames: Record<string, string> = {
  web_search: '联网搜索',
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
