/** 按 RFC 4180 解析 CSV：支持引号字段、转义双引号与引号内换行，去掉 UTF-8 BOM；跳过真正的空行，保留引号空字段；字段中间的引号按普通字符处理。 */
// 上限仅限制保留的行列；总行数包含表头，总列数统计整个文件，供预览提示使用。
export function parseCsv(text: string, maxRows = Infinity, maxColumns = Infinity) {
  const source = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let hasQuotedField = false
  let hasContent = false
  let column = 0
  let totalRows = 0
  let columns = 0
  const finishField = () => {
    if (totalRows < maxRows && column < maxColumns) row.push(field)
    column++
    field = ''
    hasContent = false
  }
  const finishRow = () => {
    finishField()
    if (totalRows < maxRows) {
      rows.push(row)
      row = []
    }
    totalRows++
    columns = Math.max(columns, column)
    column = 0
    hasQuotedField = false
  }
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') i++
        else {
          quoted = false
          continue
        }
      }
    } else if (char === '"' && !hasContent) {
      quoted = true
      hasQuotedField = true
      continue
    } else if (char === ',') {
      finishField()
      continue
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++
      if (column || hasContent || hasQuotedField) finishRow()
      continue
    }
    // Count every logical record, but allocate text/cells only inside the requested preview.
    if (totalRows < maxRows && column < maxColumns) field += char
    hasContent = true
  }
  if (hasContent || column || hasQuotedField) finishRow()
  return { rows, totalRows, columns }
}
