export interface Chunk {
  ordinal: number
  start: number
  end: number
  heading: string
  text: string
}

const MAX_LENGTH = 1600
const OVERLAP = 160
/** A shorter section merges with the next; calibrate against the retrieval evaluation set. */
const MIN_LENGTH = 300
const POLICY_LEVELS: Record<string, number> = { 编: 1, 部分: 1, 章: 2, 节: 3, 条: 4 }

// ponytail: line-based policy/Markdown headings; extend only for formats found in real sources.
// Clauses and items such as （一） or 1. stay inside their article; a long article still splits
// at paragraph or sentence boundaries.
function headingOf(line: string): [number, string] | undefined {
  const value = line.trim()
  const policy =
    /^(第[一二三四五六七八九十百千万亿〇零两0-9０-９]+(编|部分|章|节|条)(?:之[一二三四五六七八九十0-9０-９]+)?)/u.exec(
      value,
    )
  if (policy) {
    const level = POLICY_LEVELS[policy[2]]
    return [level, level < 4 && value.length <= 120 ? value : policy[1]]
  }
  const markdown = /^(#{1,4})[ \t]+.+/.exec(value)
  if (markdown && value.length <= 120) return [markdown[1].length, value]
  if (/^[一二三四五六七八九十百]+、/.test(value) && value.length <= 120) return [2, value]
}

function splitsSurrogate(text: string, offset: number) {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/**
 * Offsets are UTF-16 indices for text.slice(start, end); ordinals start at zero. A heading line
 * never forms a chunk by itself, and a chunk's heading is the path its merged sections share.
 */
export function chunkText(text: string): Chunk[] {
  if (!text.trim()) return []
  const chunks: Chunk[] = []
  const append = (from: number, to: number, heading: string) => {
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
  const headings: string[] = []
  let start = 0
  let label: string[] = []
  // Whether the pending section has text beyond heading lines, and where the last heading ended.
  let body = false
  let lineEnd = 0
  for (const line of text.matchAll(/^[^\r\n]+/gm)) {
    const heading = headingOf(line[0])
    if (!heading) continue
    body ||= !!text.slice(lineEnd, line.index).trim()
    if (body && text.slice(start, line.index).trim().length >= MIN_LENGTH) {
      append(start, line.index, label.join(' / '))
      start = line.index
      body = false
    }
    headings.length = heading[0]
    headings[heading[0]] = heading[1]
    const path = headings.filter(Boolean)
    if (!body) label = path
    else {
      let shared = 0
      while (shared < label.length && label[shared] === path[shared]) shared++
      label = label.slice(0, shared)
    }
    // “第一条 正文……” carries text on the heading line itself.
    body ||= line[0].trim() !== heading[1]
    lineEnd = line.index + line[0].length
  }
  append(start, text.length, label.join(' / '))
  return chunks
}
