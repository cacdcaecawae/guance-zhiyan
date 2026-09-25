/** 按 RFC 4180 解析 CSV：支持引号字段、转义双引号与引号内换行，去掉 UTF-8 BOM；跳过空行，字段中间的引号按普通字符处理。 */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted) {
      if (char !== '"') field += char
      else if (source[i + 1] === '"') field += source[++i]
      else quoted = false
    } else if (char === '"' && field === '') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++
      if (!row.length && !field) continue
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += char
  }
  if (field || row.length) rows.push([...row, field])
  return rows
}
