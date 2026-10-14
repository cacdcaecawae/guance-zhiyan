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

const lineAt = (text: string, from: number) => {
  const end = text.indexOf('\n', from)
  return text.slice(from, end < 0 ? undefined : end)
}

/** First line of the run of lines matching `test` that holds `start`, or undefined. */
function blockStart(text: string, start: number, test: (line: string) => boolean) {
  let line = text.lastIndexOf('\n', start - 1) + 1
  if (!test(lineAt(text, line))) return undefined
  while (line > 0) {
    const previous = text.lastIndexOf('\n', line - 2) + 1
    if (previous === line || !test(lineAt(text, previous))) break
    line = previous
  }
  return line
}

/**
 * Header row of the Markdown table a chunk starts inside, when that row lies before the chunk.
 * A long table splits between rows; later chunks carry the header in their heading so their
 * cells keep their column names, while the chunk text stays an exact slice of the source.
 * Rows are lines with a cell separator; the outer pipes are optional (`指标 | 单位`).
 * ponytail: a header over 300 code units keeps its leading whole columns and ends with “…”, which
 * bounds every chunk heading; the later column names are dropped.
 */
function tableHeader(text: string, start: number) {
  const line = blockStart(text, start, (row) => row.includes('|'))
  if (line === undefined || line >= start) return undefined
  const header = lineAt(text, line).trim()
  const separator = lineAt(text, line + lineAt(text, line).length + 1)
  if (!/^[ \t]*\|?[ \t]*:?-{3,}/.test(separator)) return undefined
  if (header.length <= 300) return header
  const cut = header.lastIndexOf('|', 300)
  return cut > 0 ? `${header.slice(0, cut + 1)} …` : undefined
}

/** Written by the import pipeline as the first line of a `>` quote holding image OCR text. */
const IMAGE_TEXT = '〔图片文字，OCR 识别，非原文正文〕'
/**
 * Whether a chunk starts inside an image-text quote whose marker line lies before the chunk.
 * Later chunks of a long OCR block carry the note in their heading, so their text is never
 * taken for the document body.
 */
function inImageText(text: string, start: number) {
  const line = blockStart(text, start, (quote) => /^[ \t]*>/.test(quote))
  return line !== undefined && line < start && lineAt(text, line).includes(IMAGE_TEXT)
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
      const header = tableHeader(text, start)
      chunks.push({
        ordinal: chunks.length,
        start,
        end,
        heading: [
          heading,
          header && `表头 ${header}`,
          inImageText(text, start) && '图片文字续（以 > 开头的行为 OCR 识别，非原文正文）',
        ]
          .filter(Boolean)
          .join(' / '),
        text: text.slice(start, end),
      })
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
