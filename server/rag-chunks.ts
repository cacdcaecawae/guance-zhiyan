export interface Chunk {
  ordinal: number
  start: number
  end: number
  heading: string
  text: string
}

const MAX_LENGTH = 1600
const OVERLAP = 160
const POLICY_LEVELS: Record<string, number> = { 编: 1, 部分: 1, 章: 2, 节: 3, 条: 4, 款: 5 }

// ponytail: line-based policy/Markdown headings; extend only for formats found in real sources.
function headingOf(line: string): [number, string] | undefined {
  const value = line.trim()
  const policy =
    /^(第[一二三四五六七八九十百千万亿〇零两0-9０-９]+(编|部分|章|节|条|款)(?:之[一二三四五六七八九十0-9０-９]+)?)/u.exec(
      value,
    )
  if (policy) {
    const level = POLICY_LEVELS[policy[2]]
    return [level, level < 4 && value.length <= 120 ? value : policy[1]]
  }
  const markdown = /^(#{1,6})[ \t]+.+/.exec(value)
  if (markdown && value.length <= 120) return [markdown[1].length, value]
  if (/^[一二三四五六七八九十百]+、/.test(value) && value.length <= 120) return [2, value]
  const clause = /^[（(][一二三四五六七八九十百0-9０-９]+[）)]/.exec(value)
  if (clause) return [5, clause[0]]
  const item = /^[0-9０-９]+[、.．](?=[ \t\u3000\u4e00-\u9fff])/.exec(value)
  if (item) return [6, item[0]]
}

function splitsSurrogate(text: string, offset: number) {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/** Offsets are UTF-16 indices for text.slice(start, end); ordinals start at zero. */
export function chunkText(text: string): Chunk[] {
  if (!text.trim()) return []
  const chunks: Chunk[] = []
  const headings: string[] = []
  const append = (from: number, to: number) => {
    const heading = headings.filter(Boolean).join(' / ')
    let start = from
    while (start < to) {
      let end = Math.min(start + MAX_LENGTH, to)
      if (end < to) {
        const middle = start + MAX_LENGTH / 2
        const tail = text.slice(middle, end)
        const paragraph = Math.max(tail.lastIndexOf('\n'), tail.lastIndexOf('\r'))
        if (paragraph >= 0) end = middle + paragraph + 1
        else {
          for (const sentence of tail.matchAll(/[。！？；.!?;][”’"』」]?/gu))
            end = middle + sentence.index + sentence[0].length
        }
        if (text[end - 1] === '\r' && text[end] === '\n') end--
        if (splitsSurrogate(text, end)) end--
      }
      chunks.push({ ordinal: chunks.length, start, end, heading, text: text.slice(start, end) })
      if (end === to) break
      start = end - OVERLAP
      if (splitsSurrogate(text, start)) start++
    }
  }
  let start = 0
  for (const line of text.matchAll(/^[^\r\n]+/gm)) {
    const heading = headingOf(line[0])
    if (!heading) continue
    if (line.index > start && text.slice(start, line.index).trim()) {
      append(start, line.index)
      start = line.index
    }
    headings.length = heading[0]
    headings[heading[0]] = heading[1]
  }
  append(start, text.length)
  return chunks
}
