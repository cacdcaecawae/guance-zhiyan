export const toolNames: Record<string, string> = {
  web_search: '联网搜索',
  web_fetch: '读取网页',
  create_file: '生成文件',
  read_file: '读取文件',
  list_files: '列出文件',
}
export function toolSummary(input: string): string {
  try {
    const value = JSON.parse(input)
    const summary = value.queries?.join(' · ') ?? value.url ?? value.name ?? value.id
    return typeof summary === 'string' ? summary : input
  } catch {
    return input
  }
}
