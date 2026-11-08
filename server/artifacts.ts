import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableBorders,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
} from 'docx'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import PptxGenJS from 'pptxgenjs'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Artifact, SlideBody, SlidePlan, SlideSeg } from '../src/types/index.ts'
import { LibraryStore } from './rag-store.ts'
import { Store, HttpError } from './store.ts'

export const MIME: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
const MAX_CONTENT = 200_000
const MAX_USER_BYTES = 50 * 1024 * 1024
// XML 1.0 cannot represent these characters, even as character references, so Office files can't.
const xmlInvalid = (text: string) =>
  !text.isWellFormed() ||
  Array.from(text).some((char) => {
    const code = char.codePointAt(0)!
    return (code < 32 && !'\t\n\r'.includes(char)) || code === 0xfffe || code === 0xffff
  })
type GeneratedFormat = 'md' | 'docx' | 'pptx' | 'xlsx' | 'csv'
type Workspace = {
  readOffice(data: Uint8Array, format: 'docx' | 'xlsx', signal?: AbortSignal): Promise<string>
}
/**
 * Rethrows a tool failure, as ABORTED when it is the cancellation of `signal` itself (its reason, or
 * an AbortError), so a stopped tool shows as interrupted: DSH records no code for these. Any other
 * failure, such as a file system error at the same moment, keeps its own cause.
 */
export const rethrowStopped =
  (signal?: AbortSignal) =>
  (error: unknown): never => {
    if (
      signal?.aborted &&
      (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
    )
      throw new HarnessError('工具执行已中断。', 'ABORTED')
    throw error
  }
export const contentOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
}

const markdown = unified().use(remarkParse).use(remarkGfm)
type Block = ReturnType<typeof markdown.parse>['children'][number]
type Inline = Extract<Block, { type: 'paragraph' }>['children'][number]
/** sup 为文献引用编号（source 为所引片段），code 为行内代码 */
type Seg = {
  text: string
  bold?: boolean
  italics?: boolean
  strike?: boolean
  link?: string
  sup?: boolean
  source?: Source
  code?: boolean
}
type Align = NonNullable<Extract<Block, { type: 'table' }>['align']>
/** depth 为列表嵌套层数（0 不在列表中）；mark 只在列表项的第一行 */
type Line = {
  type: 'line'
  segs: Seg[]
  depth: number
  quote: boolean
  /** list 区分各个列表，start 为列表起始号，n 为本项编号 */
  mark?: { list: number; ordered: boolean; start: number; n: number }
}
type Item =
  | { type: 'heading'; depth: number; segs: Seg[] }
  | Line
  /** 行 × 列 × 单元格内各行 */
  | { type: 'table'; rows: Seg[][][][]; align: Align }
/** 文件里引用的文献库片段：id 为片段编号，label 为链接文字 */
type Source = { id: string; label: string }

const RED = 'B0302A'
const PASSAGE = /^\/api\/library\/passages\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i
/** 检索工具给的现成引用写法（rag-tools.ts 的 cite）的链接文字：文件正文只留引用编号，文献名列在文末 */
const TOOL_CITE = /^planid \S+·原文$/
/** 文件引了文献库原文时，随生成结果提醒模型：对话里复述的内容同样附出处 */
const FILE_REPLY =
  '回复里写到文件中的具体要点或数字时，每条末尾原样复制所依据片段的 cite，不能只写文献编号；不写“已核对无误”之类的自我评价。'
/** 表格单元格里的文献库原文链接（JSON 写法的表格不经 Markdown 解析） */
const CELL_CITE =
  /\[([^\]]*)\]\(\s*<?\/api\/library\/passages\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})>?\s*\)/gi
const plain = (segs: Seg[]) => segs.map((seg) => seg.text).join('')
const cjk = /[㐀-鿿]/
/** 中文语境的直双引号换成弯引号：引号内含汉字才换；单引号常是英文撇号（China's），不动。替换前后长度不变。
 * 引文里再套引号（“确保"十四五"规划……。”）时，夹在两个汉字之间、紧跟着一小段不含句读的引号按内层引号 ‘’ 配对
 * （外层引文在它前后含句读才这样认，“"十三五"和"十四五"”仍是两对），否则按出现顺序成对。ponytail: 只认一层嵌套；更深的嵌套按顺序配对 */
const curly = (text: string) => {
  const at = [...text.matchAll(/"/g)].map((match) => match.index)
  if (at.length < 2) return text
  // 正则下标与替换都按 UTF-16 码元定位；未修改的代理对在 join 后原样保留。
  const out = text.split('')
  // 句读计数只建一次，避免每对引号都重新扫描行尾，或每层嵌套都重扫行首。
  const punctuation = new Uint32Array(text.length + 1)
  for (let i = 0; i < text.length; i++)
    punctuation[i + 1] = punctuation[i] + Number(/[，。；！？,;!?]/.test(text[i]))
  const short = (from: number, to: number) => {
    const inner = text.slice(from + 1, to)
    return cjk.test(inner) && Array.from(inner).length <= 20 && !/[，。；！？,;!?]/.test(inner)
  }
  for (let k = 0; k + 1 < at.length;) {
    const open = at[k]
    let close = k + 1
    const nested: [number, number][] = []
    // 外层引文较长（含句读）时，其中夹在汉字之间的短引号是内层引号，且后面还得留一个引号收尾
    while (
      close + 2 < at.length &&
      (punctuation[at[close]] > punctuation[open + 1] ||
        punctuation[at.at(-1)!] > punctuation[at[close + 1] + 1]) &&
      cjk.test(text[at[close] - 1] ?? '') &&
      cjk.test(text[at[close] + 1] ?? '') &&
      short(at[close], at[close + 1])
    ) {
      nested.push([at[close], at[close + 1]])
      close += 2
    }
    if (close >= at.length) break
    if (!cjk.test(text.slice(open + 1, at[close]))) {
      k = close + 1
      continue
    }
    out[open] = '“'
    out[at[close]] = '”'
    for (const [a, b] of nested) {
      out[a] = '‘'
      out[b] = '’'
    }
    k = close + 1
  }
  return out.join('')
}
/** 一行文字换弯引号，并补上粗体：** 紧挨中文标点时（如 **加粗：**文字）CommonMark 不认作粗体，残留的成对 ** 在这里处理。
 * 行内代码原样保留。 */
const tidy = (segs: Seg[]) => {
  const out: Seg[] = []
  for (let i = 0; i < segs.length;) {
    let j = i
    while (j < segs.length && !segs[j].code) j++
    for (const seg of tidyText(segs.slice(i, j))) out.push(seg)
    if (j < segs.length) out.push(segs[j])
    i = j + 1
  }
  return out
}
const tidyText = (segs: Seg[]) => {
  const text = curly(plain(segs))
  const owner = segs.flatMap((seg) => Array<Seg>(seg.text.length).fill(seg))
  const bold: boolean[] = []
  const drop = new Set<number>()
  for (const match of text.matchAll(/\*\*(.+?)\*\*/g)) {
    const end = match.index + match[0].length
    for (const k of [match.index, match.index + 1, end - 2, end - 1]) drop.add(k)
    for (let k = match.index + 2; k < end - 2; k++) bold[k] = true
  }
  const out: Seg[] = []
  let last: [Seg, boolean] | undefined
  for (let k = 0; k < text.length; k++) {
    if (drop.has(k)) continue
    if (last?.[0] === owner[k] && last[1] === !!bold[k]) out.at(-1)!.text += text[k]
    else out.push({ ...owner[k], text: text[k], ...(bold[k] && { bold: true }) })
    last = [owner[k], !!bold[k]]
  }
  return out
}
/** 引用编号前的“出处：”“（来源：”之类：文件里引用已编号、文献列在页脚与文末，这几个字多余 */
const CITE_LABEL = /\s*([（(]?)\s*(?:原文)?(?:出处|来源|引用)\s*[：:]\s*$/
/** 去掉紧挨引用编号的“出处：”字样，连同它带的左括号与编号后对应的右括号 */
const dropCiteLabels = (segs: Seg[]) => {
  const out = segs.map((seg) => ({ ...seg }))
  out.forEach((seg, k) => {
    if (!seg.sup || out[k - 1]?.sup) return
    const before = out[k - 1]
    const match = before && CITE_LABEL.exec(before.text)
    if (!match) return
    before.text = before.text.slice(0, match.index)
    if (!match[1]) return
    let end = k
    while (out[end + 1]?.sup) end++
    const after = out[end + 1]
    if (after) after.text = after.text.replace(/^\s*[）)]/, '')
  })
  return out.filter((seg) => seg.text)
}
/** 显示宽度：中日韩及全角字符计 2，其余计 1 */
const textWidth = (text: string) =>
  Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0)
const cellWidth = (lines: Seg[][]) => Math.max(0, ...lines.map((line) => textWidth(plain(line))))
/** 列宽：按所需宽度从小到大依次给足（至多均分剩下的宽度），最长的列分剩余；都放得下时按比例放大到总宽 */
const fitColumns = (needs: number[], total: number) => {
  const widths = [...needs]
  let rest = total
  needs
    .map((need, i) => [need, i])
    .sort((a, b) => a[0] - b[0])
    .forEach(([need, i], k) => {
      widths[i] = Math.min(need, rest / (needs.length - k))
      rest -= widths[i]
    })
  const sum = widths.reduce((a, b) => a + b, 0)
  return widths.map((width) => (width * total) / sum)
}

/** 每格加引号的 CSV，与前端 parseCsv 互逆；guard 时给以 = + @ - 开头的文字加 '，免得表格软件当公式执行 */
const csv = (rows: (string | number)[][], guard: boolean) =>
  rows
    .map((row) =>
      row
        .map((cell) => {
          const text =
            guard && typeof cell === 'string' && /^[\s]*[=+@-]/u.test(cell)
              ? `'${cell}`
              : String(cell)
          return `"${text.replaceAll('"', '""')}"`
        })
        .join(','),
    )
    .join('\r\n')

// PowerPoint 的段落层级最多 9 级（0–8），自动编号起始号与 Word 一样最大 32767
const MAX_LEVEL = 8
const MAX_START = 32767
/** 表格与 Excel 一致最多 2000 行、50 列（Word 表格最多 63 列，行数过多时生成要数秒） */
const MAX_ROWS = 2000
const MAX_COLUMNS = 50
/**
 * 解析前的守卫。remark 处理强调符号（* _ ~）与方括号（链接）是二次方的，20 万字节的病态输入能卡住事件循环数分钟；
 * 行数极多时（每行一字、硬换行、列表项、标题）解析与生成要十几秒、数百 MB 内存；
 * 一行开头的引用、列表标记或缩进嵌套过深会爆栈或拖到秒级。
 * ponytail: 上限取评测中 8 份真实报告最大值（124 个强调符号、36 个原文链接、嵌套 1 层、缩进 2 格；
 * 最密的每行 52 字节，按 200 KB 篇幅约 3850 行）放大后再留余量，2000 行的表格也在其内；
 * 在上限内最坏的输入本机约 0.5 秒。要放宽就把解析挪到子进程或换线性解析器。
 */
const tooComplex = (content: string) =>
  (content.match(/\r\n?|\n/g)?.length ?? 0) >= 5000 ||
  (content.match(/[*_]/g)?.length ?? 0) > 6000 ||
  (content.match(/~/g)?.length ?? 0) > 2000 ||
  (content.match(/\[/g)?.length ?? 0) > 3000 ||
  /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))){17}/m.test(content) ||
  /^[ \t]{65}/m.test(content)

/** Markdown 展开为标题、文字行与表格的序列，Word、演示文稿与表格共用。空行、分隔线、链接定义等不输出。
 * 文献库原文链接只留文字（工具给的现成引用连文字也不留），后附引用编号（同一片段同一编号），sources 按编号列出片段。
 * 正文过于复杂或解析失败时按 code 报错。 */
export function flatten(content: string, code: string) {
  const items: Item[] = []
  const sources: Source[] = []
  let lists = 0
  let mark: Line['mark']
  /** 行内内容拆成行（换行、<br> 各起一行），每行为带格式的文字段。HTML 标签不显示；
   * 其他相对链接在下载后的文件里打不开，只保留文字，http(s) 链接保留地址。 */
  const inline = (nodes: readonly Inline[], style: Omit<Seg, 'text'> = {}, out: Seg[][] = [[]]) => {
    for (const node of nodes) {
      if (node.type === 'text' || node.type === 'inlineCode')
        node.value.split('\n').forEach((text, i) => {
          if (i) out.push([])
          if (text)
            out.at(-1)!.push({ ...style, text, ...(node.type === 'inlineCode' && { code: true }) })
        })
      else if (node.type === 'break' || (node.type === 'html' && /^<br\s*\/?>$/i.test(node.value)))
        out.push([])
      else if (node.type === 'strong') inline(node.children, { ...style, bold: true }, out)
      else if (node.type === 'emphasis') inline(node.children, { ...style, italics: true }, out)
      else if (node.type === 'delete') inline(node.children, { ...style, strike: true }, out)
      else if (node.type === 'link') {
        const passage = PASSAGE.exec(node.url)?.[1].toLowerCase()
        const web = !passage && /^https?:\/\//i.test(node.url)
        const label = plain(tidy(inline(node.children).flat()))
        if (!passage || !TOOL_CITE.test(label))
          inline(node.children, web ? { ...style, link: node.url } : style, out)
        if (passage) {
          const n =
            sources.findIndex((source) => source.id === passage) + 1 ||
            sources.push({ id: passage, label })
          out.at(-1)!.push({ text: `[${n}]`, sup: true, source: sources[n - 1] })
        }
      } else if (node.type === 'linkReference') inline(node.children, style, out)
      else if ((node.type === 'image' || node.type === 'imageReference') && node.alt)
        out.at(-1)!.push({ ...style, text: node.alt })
      else if (node.type === 'footnoteReference')
        out.at(-1)!.push({ ...style, text: `[${node.label ?? node.identifier}]` })
    }
    return out
  }
  const text = (nodes: readonly Inline[]) => inline(nodes).map(tidy)
  const lines = (lines: Seg[][], depth: number, quote: boolean) => {
    for (const raw of lines) {
      const segs = dropCiteLabels(raw)
      if (!segs.length) continue
      // 只有引用编号的一行（模型常把 cite 另起一行，或写成“> 出处：[…]”）接到上一行末尾
      const last = items.at(-1)
      if (last?.type === 'line' && segs.every((seg) => seg.sup || !seg.text.trim())) {
        last.segs.push(...segs.filter((seg) => seg.sup))
        mark = undefined
        continue
      }
      items.push({ type: 'line', segs, depth, quote, mark })
      mark = undefined
    }
  }
  const walk = (nodes: readonly Block[], depth: number, quote: boolean) => {
    for (const node of nodes) {
      if (node.type === 'heading')
        items.push({ type: 'heading', depth: node.depth, segs: text(node.children).flat() })
      else if (node.type === 'paragraph') lines(text(node.children), depth, quote)
      else if (node.type === 'code')
        lines(
          node.value.split('\n').map((text) => (text ? [{ text }] : [])),
          depth,
          quote,
        )
      else if (node.type === 'html')
        lines(
          node.value
            .replace(/<[^>]*>/g, '')
            .split('\n')
            .filter((text) => text.trim())
            .map((text) => [{ text }]),
          depth,
          quote,
        )
      else if (node.type === 'list') {
        // 每个列表单独编号，从原文写的起始号编起
        const list = ++lists
        const start = Math.min(node.start ?? 1, MAX_START)
        node.children.forEach((item, i) => {
          mark = { list, ordered: !!node.ordered, start, n: Math.min(start + i, MAX_START) }
          walk(item.children, depth + 1, quote)
          mark = undefined
        })
      } else if (node.type === 'table') {
        const columns = node.children[0].children.length
        if (columns > MAX_COLUMNS || node.children.length > MAX_ROWS)
          throw new HarnessError(
            `表格最多 ${MAX_ROWS} 行、${MAX_COLUMNS} 列。`,
            'FILE_INVALID_TABLE',
          )
        items.push({
          type: 'table',
          align: node.align ?? [],
          // GFM：单元格按表头列数补齐，多出的忽略
          rows: node.children.map((row) =>
            Array.from({ length: columns }, (_, j) => text(row.children[j]?.children ?? [])),
          ),
        })
      } else if (node.type === 'blockquote') walk(node.children, depth, true)
      else if (node.type === 'footnoteDefinition') walk(node.children, depth, quote)
    }
  }
  const fail = () =>
    new HarnessError(
      '正文超过 5000 行，或强调符号、链接、嵌套层级过多，无法排版，请精简后重试。',
      code,
    )
  if (tooComplex(content)) throw fail()
  try {
    // 解析器在文字中保留原样的换行符，统一成 \n 再按行拆分。
    // 只由 - 或 = 组成的行去掉：分隔线本就不输出，紧跟正文时 Markdown 会把上一行当成标题（setext）。
    // 代码块里这样的行也会去掉。
    const source = content.replace(/\r\n?/g, '\n').replace(/^ {0,3}(?:-+|=+)[ \t]*$/gm, '')
    walk(markdown.parse(source).children, 0, false)
  } catch (error) {
    if (error instanceof RangeError || error instanceof SyntaxError) throw fail()
    throw error
  }
  return { items, sources }
}

// eastAsia 提示让“”等中西文共用的标点按中文全角排
const SONG = {
  ascii: 'Times New Roman',
  hAnsi: 'Times New Roman',
  eastAsia: '宋体',
  hint: 'eastAsia',
}
const HEI = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: '黑体', hint: 'eastAsia' }
const KAI = { ...SONG, eastAsia: '楷体' }
const headingStyle = (size: number, before: number, outlineLevel: number) => ({
  run: { font: HEI, size, bold: true, color: '000000' },
  paragraph: { spacing: { before, after: 120 }, keepNext: true, keepLines: true, outlineLevel },
})
/** A4 默认页边距下的正文宽度（缇） */
const PAGE_WIDTH = 11906 - 2 * 1440
const listLevels = (
  format: (typeof LevelFormat)[keyof typeof LevelFormat],
  text: string[],
  start = 1,
) =>
  text.map((text, level) => ({
    level,
    start,
    format,
    text,
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: { indent: { left: 900 + 480 * level, hanging: 420 } },
      // 符号用西文字体，不按中文全角排
      run: { font: { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Arial' } },
    },
  }))

/** Word：开头的 # 标题作文档标题（其后以破折号开头的标题作副标题），其余标题依次用 1–4 级标题样式；
 * 正文首行缩进两字，表格表头加底色并跨页重复；页眉为短标题，页脚“第 X 页 / 共 Y 页”。
 * 一级章节不少于 3 个的长报告加封面，标题与首个章节前的说明放在封面上。文末列出引用来源，每条由 source 写出。 */
function docx(content: string, name: string, source: (source: Source) => string) {
  const { items, sources } = flatten(content, 'FILE_INVALID_DOCX_CONTENT')
  const head = items[0]
  const titled = head?.type === 'heading' && head.depth === 1
  const next = items[1]
  const subtitle =
    titled && next?.type === 'heading' && /^[—–-]/.test(plain(next.segs)) ? next.segs : undefined
  const title = titled ? plain(head.segs) : name
  const body = items.slice(titled ? (subtitle ? 2 : 1) : 0)
  // 有文档标题时 ## 是一级章节
  const shift = titled ? 1 : 0
  const cover =
    titled && body.filter((item) => item.type === 'heading' && item.depth === 1 + shift).length >= 3
  const preamble = cover
    ? body.splice(
        0,
        body.findIndex((item) => item.type === 'heading'),
      )
    : []
  const runs = (segs: Seg[], size?: number) =>
    segs.map(({ link, sup, code: _code, ...seg }) => {
      const run = new TextRun({
        ...seg,
        size,
        style: link ? 'Hyperlink' : undefined,
        ...(sup && { superScript: true, color: RED }),
      })
      return link ? new ExternalHyperlink({ link, children: [run] }) : run
    })
  const table = ({ rows, align }: Extract<Item, { type: 'table' }>) => {
    // 五列及以上用小五号字；一个汉字的宽度（缇）为半磅字号 × 10，按半字宽计，另加单元格左右边距
    const size = rows[0].length >= 5 ? 18 : 21
    const widths = fitColumns(
      rows[0].map((_, j) => Math.max(...rows.map((row) => cellWidth(row[j]))) * size * 5 + 240),
      PAGE_WIDTH,
    ).map(Math.round)
    const border = { style: BorderStyle.SINGLE, size: 4, color: '7F7F7F' }
    return new Table({
      width: { size: PAGE_WIDTH, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      margins: { top: 50, bottom: 50, left: 100, right: 100 },
      borders: Object.fromEntries(
        ['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map((side) => [
          side,
          border,
        ]),
      ),
      rows: rows.map(
        (row, i) =>
          new TableRow({
            tableHeader: i === 0,
            cantSplit: true,
            children: row.map(
              (lines, j) =>
                new TableCell({
                  width: { size: widths[j], type: WidthType.DXA },
                  verticalAlign: VerticalAlignTable.CENTER,
                  shading: i
                    ? undefined
                    : { type: ShadingType.CLEAR, fill: 'E7E6E6', color: 'auto' },
                  children: lines.map(
                    (segs) =>
                      new Paragraph({
                        style: 'TableText',
                        alignment: i
                          ? {
                              left: AlignmentType.LEFT,
                              center: AlignmentType.CENTER,
                              right: AlignmentType.RIGHT,
                            }[align[j] ?? 'left']
                          : AlignmentType.CENTER,
                        children: runs(
                          i ? segs : segs.map((seg) => ({ ...seg, bold: true })),
                          size,
                        ),
                      }),
                  ),
                }),
            ),
          }),
      ),
    })
  }
  const render = (item: Item) => {
    if (item.type === 'heading')
      return new Paragraph({
        heading: [
          HeadingLevel.HEADING_1,
          HeadingLevel.HEADING_2,
          HeadingLevel.HEADING_3,
          HeadingLevel.HEADING_4,
        ][Math.max(1, Math.min(item.depth - shift, 4)) - 1],
        children: runs(item.segs),
      })
    // 表后留 6 磅空段：相邻表格不会被 Word 合并；文末是表格时 Word 补的空段也不会被挤到新的一页
    if (item.type === 'table')
      return [table(item), new Paragraph({ spacing: { line: 120, lineRule: LineRuleType.EXACT } })]
    const level = Math.min(item.depth, 3) - 1
    if (item.mark)
      return new Paragraph({
        numbering: {
          // 有序列表按起始号分编号定义，每个列表一个实例
          reference: item.mark.ordered ? `ordered-${item.mark.start}` : 'bullet',
          level,
          instance: item.mark.ordered ? item.mark.list : 0,
        },
        children: runs(item.segs),
      })
    return new Paragraph({
      style: item.quote && level < 0 ? 'Quote' : undefined,
      indent:
        level >= 0 ? { left: 900 + 480 * level } : item.quote ? undefined : { firstLine: 480 },
      children: runs(item.segs),
    })
  }
  const titleBlock = (before: number, size?: number) =>
    titled
      ? [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            spacing: { before },
            children: runs(head.segs, size),
          }),
          ...(subtitle
            ? [
                new Paragraph({
                  style: 'Subtitle',
                  children: runs([
                    { ...subtitle[0], text: subtitle[0].text.replace(/^[—–-]+\s*/, '') },
                    ...subtitle.slice(1),
                  ]),
                }),
              ]
            : []),
        ]
      : []
  const note = { size: 18, color: '7F7F7F' }
  const short = Array.from(title)
  const main = {
    headers: {
      default: new Header({
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF', space: 4 } },
            children: [
              new TextRun({
                text: short.length > 30 ? short.slice(0, 29).join('') + '…' : title,
                ...note,
              }),
            ],
          }),
        ],
      }),
    },
    footers: {
      default: new Footer({
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                children: [
                  '第 ',
                  PageNumber.CURRENT,
                  ' 页 / 共 ',
                  PageNumber.TOTAL_PAGES_IN_SECTION,
                  ' 页',
                ],
                ...note,
              }),
            ],
          }),
        ],
      }),
    },
    children: [
      ...(cover ? [] : titleBlock(0)),
      ...body.flatMap(render),
      ...(sources.length
        ? [
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('引用来源')] }),
            ...sources.map(
              (item, i) =>
                new Paragraph({
                  style: 'Source',
                  children: [new TextRun(`[${i + 1}]\t${source(item)}`)],
                }),
            ),
          ]
        : []),
    ],
  }
  return Packer.toBuffer(
    new Document({
      title,
      creator: '管策智研',
      styles: {
        default: {
          document: { run: { font: SONG, size: 24 }, paragraph: { spacing: { line: 360 } } },
          title: {
            run: { font: HEI, size: 36, bold: true, color: '000000' },
            paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 240, after: 240 } },
          },
          heading1: headingStyle(32, 360, 0),
          heading2: headingStyle(28, 240, 1),
          heading3: headingStyle(24, 180, 2),
          heading4: { ...headingStyle(24, 120, 3), run: { font: SONG, size: 24, bold: true } },
        },
        paragraphStyles: [
          {
            id: 'TableText',
            name: 'Table Text',
            basedOn: 'Normal',
            run: { size: 21 },
            paragraph: { spacing: { line: 276 } },
          },
          {
            id: 'Quote',
            name: 'Quote',
            basedOn: 'Normal',
            run: { font: KAI, color: '404040' },
            paragraph: {
              indent: { left: 480, right: 480 },
              spacing: { before: 80, after: 80 },
              contextualSpacing: true,
              border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'BFBFBF', space: 8 } },
            },
          },
          {
            id: 'Subtitle',
            name: 'Subtitle',
            basedOn: 'Normal',
            run: { font: KAI, size: 28, color: '404040' },
            paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 360 } },
          },
          {
            id: 'Source',
            name: 'Source',
            basedOn: 'Normal',
            run: { size: 18, color: '595959' },
            paragraph: { indent: { left: 600, hanging: 600 }, spacing: { line: 276 } },
          },
        ],
      },
      numbering: {
        config: [
          { reference: 'bullet', levels: listLevels(LevelFormat.BULLET, ['•', '◦', '▪']) },
          ...[
            ...new Set(
              items.flatMap((item) =>
                item.type === 'line' && item.mark?.ordered ? [item.mark.start] : [],
              ),
            ),
          ].map((start) => ({
            reference: `ordered-${start}`,
            levels: listLevels(LevelFormat.DECIMAL, ['%1.', '(%2)', '%3)'], start),
          })),
        ],
      },
      sections: cover
        ? [
            {
              children: [
                ...titleBlock(2400, 44),
                new Paragraph({
                  indent: { left: 3600, right: 3600 },
                  border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: RED, space: 1 } },
                  spacing: { after: 960 },
                }),
                ...(preamble.length
                  ? [
                      new Table({
                        width: { size: PAGE_WIDTH, type: WidthType.DXA },
                        columnWidths: [PAGE_WIDTH],
                        borders: TableBorders.NONE,
                        rows: [
                          new TableRow({
                            children: [
                              new TableCell({
                                width: { size: PAGE_WIDTH, type: WidthType.DXA },
                                shading: { type: ShadingType.CLEAR, fill: 'F5F5F5', color: 'auto' },
                                margins: { top: 160, bottom: 160, left: 240, right: 240 },
                                children: preamble.flatMap(render),
                              }),
                            ],
                          }),
                        ],
                      }),
                    ]
                  : []),
              ],
            },
            { properties: { page: { pageNumbers: { start: 1 } } }, ...main },
          ]
        : [main],
    }),
  )
}

/** 演示文稿的配色、字号与版面尺寸（英寸，16:9 宽屏 13.33 × 7.5），取自 Opus 版样稿，规则见 DESIGN.md“生成文件版式” */
const DECK = {
  font: '微软雅黑',
  ink: '1F1F22',
  sub: '5A5A60',
  mute: '8A8A90',
  deep: '8C2A24',
  dark: '232327',
  card: 'F4F3F2',
  line: 'DDDBD9',
  x: 0.6,
  w: 12.1,
  top: 1.45,
  /** 正文区高度：其下 6.45 起放页底注，6.95 起放来源脚注与页码 */
  height: 5,
}
/** 每个显示宽度单位（半个汉字）在各字号下的英寸数 */
const UNIT = (size: number) => size / 72 / 2
/** 小标题像“一、”“1.”“（一）”“第一章”这类章节编号时，开头的 # 标题不作封面 */
const ORDINAL =
  /^(?:[一二三四五六七八九十百]+、|（[一二三四五六七八九十]+）|\d+[.、．]|第.{1,4}[章节篇部分])/
/** 并成标签时去掉的章节编号前缀（卡片另有编号圆） */
const ORDINAL_PREFIX = /^(?:[一二三四五六七八九十百]+、|（[一二三四五六七八九十]+）|\d+[.、．])\s*/
type Cite = { doc: string; part: string }
type SlideRow = { label: Seg[]; body: Seg[] }
/** 引导语（15 磅）占的高度：每行约 0.28 英寸，段间与下方各留一点 */
const leadHeight = (lead: Seg[][]) =>
  lead.length
    ? lead.reduce(
        (sum, segs) =>
          sum + Math.max(1, Math.ceil((textWidth(plain(segs)) * UNIT(15)) / DECK.w)) * 0.28 + 0.06,
        0.12,
      )
    : 0
/** 只有引用编号的一行：编号的文献已写在页脚，不再作页底注 */
const citeOnly = (segs: Seg[]) => segs.every((seg) => seg.sup || !seg.text.trim())
/** 几行文字接成一段，前一行不以句读结尾时补“；” */
const joinLines = (lines: Line[]) =>
  lines.flatMap((line, i) =>
    i && !/[。！？；…”’）)]$/.test(plain(lines[i - 1].segs).trim())
      ? [{ text: '；' }, ...line.segs]
      : line.segs,
  )

/** 按字符位置把一行文字段切成两半 */
const splitSegs = (segs: Seg[], at: number): [Seg[], Seg[]] => {
  const head: Seg[] = []
  const rest: Seg[] = []
  let used = 0
  for (const seg of segs) {
    const cut = Math.max(0, Math.min(seg.text.length, at - used))
    if (cut) head.push({ ...seg, text: seg.text.slice(0, cut) })
    if (cut < seg.text.length) rest.push({ ...seg, text: seg.text.slice(cut) })
    used += seg.text.length
  }
  return [head, rest]
}
/** “**标签**：说明”一行（列表项里不加粗的“标签：说明”也算）拆成标签与说明；
 * 标签过长（超过 12 个汉字）或不是这种写法时返回 undefined */
const labelOf = (item: Line): SlideRow | undefined => {
  if (item.quote || item.depth > 1) return
  const k = item.segs.findIndex((seg) => !seg.bold && seg.text.trim())
  if (k === 0 && item.mark) {
    const match = /^([^：:，。；、“”"\s]{1,12})[：:]/.exec(plain(item.segs))
    if (!match || textWidth(match[1]) > 24) return
    const [, body] = splitSegs(item.segs, match[0].length)
    return body.length ? { label: [{ text: match[1], bold: true }], body } : undefined
  }
  if (k <= 0) return
  const head = plain(item.segs.slice(0, k))
  const rest = item.segs.slice(k)
  if (!/[：:]\s*$/.test(head) && !/^\s*[：:]/.test(rest[0].text)) return
  const label = head.trim().replace(/[：:]$/, '')
  if (!label || textWidth(label) > 24) return
  return {
    label: [{ text: label, bold: true }],
    body: [{ ...rest[0], text: rest[0].text.replace(/^\s*[：:]\s*/, '') }, ...rest.slice(1)],
  }
}
/** 标签行：标签列宽按本节最长的标签定，各行高按字数估算 */
const labelWidth = (rows: SlideRow[]) =>
  Math.min(
    3.2,
    Math.max(1.2, Math.max(...rows.map((row) => textWidth(plain(row.label)))) * UNIT(15) + 0.25),
  )
const rowHeight = (row: SlideRow, labelW: number) => {
  const bodyW = DECK.w - labelW - 0.3
  const label = Math.ceil((textWidth(plain(row.label)) * UNIT(15)) / labelW)
  const body = Math.max(1, Math.ceil((textWidth(plain(row.body)) * UNIT(14)) / bodyW))
  return Math.max(label * 0.3, body * 0.26) + 0.3
}
/** 卡片：标签 18 磅、说明 14 磅，返回标签区高度与卡片高度；room 为可用高度（上方有引导语时变小） */
const cardSize = (rows: SlideRow[], room = DECK.height) => {
  const inner = (DECK.w - 0.3 * (rows.length - 1)) / rows.length - 0.6
  const label =
    Math.max(...rows.map((row) => Math.ceil((textWidth(plain(row.label)) * UNIT(18)) / inner))) *
    0.34
  const body =
    Math.max(...rows.map((row) => Math.ceil((textWidth(plain(row.body)) * UNIT(14)) / inner))) *
    0.26
  return {
    label,
    height: Math.min(room - 0.1, Math.max(3.4, 1.0 + label + 0.15 + body + 0.4)),
  }
}
const toSlideSegs = (segs: Seg[]): SlideSeg[] =>
  segs.map(({ text, bold, italics, strike, link, sup }) => ({
    text,
    ...(bold && { bold }),
    ...(italics && { italics }),
    ...(strike && { strike }),
    ...(link && { link }),
    ...(sup && { sup }),
  }))

/**
 * 演示文稿分页：与 Word 同样解析 Markdown，每个标题开一页，按内容形态选版式——
 * 封面；“**标签**：说明”的行排成标签行（2–4 条且每条说明不超过约 60 字时排成并排卡片）；表格单独成页；
 * 其余为项目符号页；文末“引用来源”。> 引用作页底注，本页引用编号对应的文献写在页脚。
 * 导出文件与在线预览用同一份结果。
 */
function deckPlan(
  content: string,
  title: string,
  source: (source: Source) => string,
  cite: (id: string) => Cite | undefined,
): SlidePlan[] {
  /** rows、lead 为并入的子节（见下）与父标题下的引导语 */
  type Section = {
    title: string
    level: number
    items: Exclude<Item, { type: 'heading' }>[]
    rows?: SlideRow[]
    lead?: Seg[][]
  }
  const { items, sources } = flatten(content, 'FILE_INVALID_PPTX_CONTENT')
  const sections: Section[] = [{ title, level: 0, items: [] }]
  for (const item of items) {
    if (item.type === 'heading')
      sections.push({ title: plain(item.segs).trim(), level: item.depth, items: [] })
    else if (item.type === 'table' || plain(item.segs).trim()) sections.at(-1)!.items.push(item)
  }
  if (!sections[0].items.length) sections.shift()
  // 封面：开头的 # 标题（它是章节编号式的小标题、且正文另有其他 # 标题时用文件名），紧跟的破折号标题作副标题，
  // 两者下面不长的文字（如依据文献）也放在封面
  let cover = title
  let subtitle = ''
  let coverItems: Section['items'] = []
  const first = sections[0]
  if (
    first?.level === 1 &&
    (!first.items.length ||
      sections.filter((s) => s.level === 1).length === 1 ||
      !ORDINAL.test(first.title))
  )
    ({ title: cover, items: coverItems } = sections.shift()!)
  if (/^[—–-]/.test(sections[0]?.title ?? '')) {
    subtitle = sections[0].title.replace(/^[—–-]+\s*/, '')
    coverItems = [...coverItems, ...sections.shift()!.items]
  }
  if (
    coverItems.some((item) => item.type === 'table') ||
    coverItems.reduce(
      (sum, item) => sum + (item.type === 'line' ? plain(item.segs).length : 0),
      0,
    ) > 300
  ) {
    sections.unshift({ title: subtitle || cover, level: 1, items: coverItems })
    coverItems = []
  }
  // 父标题下的子标题都是叶子、每个子节正文很短（不超过两段、约 150 字）时，子节并进父标题那一页：
  // 子标题作标签、正文作说明（再按条数与长短排成卡片或标签行），父标题下的一两句作引导语。
  // 模型常把“四个方面：”加 4 个各只有一段的小节写成标题，逐节成页会变成一串只有一段话的稀疏页
  const body = (items: Section['items']) =>
    items.filter((item): item is Line => item.type === 'line' && !item.quote)
  const quotes = (items: Section['items']) =>
    items.filter((item): item is Line => item.type === 'line' && item.quote)
  const brief = (items: Section['items'], most: number) =>
    !items.some((item) => item.type === 'table') &&
    body(items).length <= most &&
    body(items).reduce((sum, line) => sum + Array.from(plain(line.segs)).length, 0) <= 150
  for (let s = 0; s < sections.length; s++) {
    const parent = sections[s]
    let end = s + 1
    while (end < sections.length && sections[end].level > parent.level) end++
    const children = sections.slice(s + 1, end)
    if (
      parent.level >= 1 &&
      children.length >= 2 &&
      children.every(
        (child) =>
          child.level === children[0].level && body(child.items).length && brief(child.items, 2),
      ) &&
      brief(parent.items, 2)
    ) {
      parent.lead = body(parent.items).map((line) => line.segs)
      parent.rows = children.map((child) => ({
        label: [{ text: child.title.replace(ORDINAL_PREFIX, '') || child.title, bold: true }],
        body: joinLines(body(child.items)),
      }))
      parent.items = [parent, ...children].flatMap((section) => quotes(section.items))
      sections.splice(s + 1, children.length)
    }
  }
  const plan: SlidePlan[] = [
    {
      layout: 'cover',
      title: cover,
      subtitle,
      lines: coverItems.flatMap((item) => (item.type === 'line' ? [toSlideSegs(item.segs)] : [])),
    },
  ]
  /** 来源脚注：同一文献的片段并在一起，如“[1][2]《……》 文献编号 24177 · 片段 69、70” */
  const foot = (numbers: number[]) => {
    const groups = new Map<string, { marks: string; parts: string[] }>()
    for (const n of new Set(numbers)) {
      const item = sources[n - 1]
      if (!item) continue
      const found = cite(item.id)
      const key = found?.doc ?? `${item.label}　片段 ${item.id}`
      const group = groups.get(key) ?? groups.set(key, { marks: '', parts: [] }).get(key)!
      group.marks += `[${n}]`
      if (found) group.parts.push(found.part)
    }
    const text = [...groups]
      .map(
        ([doc, { marks, parts }]) =>
          `${marks}${doc}${parts.length ? ` · 片段 ${parts.join('、')}` : ''}`,
      )
      .join('；')
    const chars = Array.from(text ? `来源：${text}` : '')
    // ponytail: 页脚两行约 160 字，超出截断；完整清单在文末“引用来源”
    return chars.length > 160 ? `${chars.slice(0, 159).join('')}…` : chars.join('')
  }
  const marks = (segs: Seg[]) =>
    segs.flatMap((seg) => (seg.source ? [sources.indexOf(seg.source) + 1] : []))
  const cellMarks = (rows: string[][]) =>
    rows.flatMap((row) =>
      row.flatMap((cell) => [...cell.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))),
    )
  // ponytail: 项目符号页按每行 52 字、每页 14 行估算分页（15 磅微软雅黑实测约 58 个汉字一行），
  // 西文与长单词按字数计偏保守；要更满的版面再按字体测宽
  const PER_LINE = 52
  const PER_SLIDE = 14
  // ponytail: 表格按 14 磅字宽估算各行行数与行高，单行高过整页时仍会超出页面；要精确再按字体测宽
  const CELL_LINE = (14 * 1.2) / 72
  const chapters: Section[] = []
  let carried: Seg[][] = []
  sections.forEach((section, s) => {
    while (chapters.length && chapters.at(-1)!.level >= section.level) chapters.pop()
    // 没有正文（至多只有引用注）、下一节层级更深的标题不单独成页，作章节名显示在其下各页标题上方
    const quoteOnly = section.items.every((item) => item.type === 'line' && item.quote)
    if (!section.rows && quoteOnly && (sections[s + 1]?.level ?? 0) > section.level) {
      chapters.push(section)
      for (const item of section.items) if (item.type === 'line') carried.push(item.segs)
      return
    }
    const kicker = chapters.at(-1)?.title ?? ''
    // 每页的正文与页底注；页底注挂在当前页
    // lead 只出现在一节的第一页
    const pages: { page: SlideBody; lead?: Seg[][]; notes: Seg[][]; marks: number[] }[] = []
    const lines = body(section.items)
    const notes = quotes(section.items)
    let lead = section.lead ?? []
    let rows = section.rows ?? lines.map(labelOf)
    // 开头一两句短引导语（如“四个方面：”）后面全是“标签：说明”时，引导语放在标签行上方
    const k = rows.findIndex(Boolean)
    if (
      !section.rows &&
      k > 0 &&
      rows.length - k >= 2 &&
      rows.slice(k).every(Boolean) &&
      brief(lines.slice(0, k), 2)
    ) {
      lead = lines.slice(0, k).map((line) => line.segs)
      rows = rows.slice(k)
    }
    if (
      section.title !== '引用来源' &&
      rows.length &&
      (section.rows ||
        (lead.length + rows.length + notes.length === section.items.length && rows.every(Boolean)))
    ) {
      const all = rows as SlideRow[]
      const room = DECK.height - leadHeight(lead)
      const cards =
        all.length >= 2 && all.length <= 4 && all.every((row) => textWidth(plain(row.body)) <= 120)
      if (cards)
        pages.push({
          page: {
            layout: 'cards',
            rows: all.map((row) => ({
              label: toSlideSegs(row.label),
              body: toSlideSegs(row.body),
            })),
          },
          notes: [],
          marks: all.flatMap((row) => marks(row.body)),
        })
      else {
        const labelW = labelWidth(all)
        // 第一页上方有引导语，可用高度小一些；之后的续页用整页
        pages.push({ page: { layout: 'rows', rows: [] }, notes: [], marks: [] })
        let used = 0
        let limit = room
        for (const row of all) {
          const height = rowHeight(row, labelW)
          if ((pages.at(-1)!.page as { rows: unknown[] }).rows.length && used + height > limit) {
            pages.push({ page: { layout: 'rows', rows: [] }, notes: [], marks: [] })
            used = 0
            limit = DECK.height
          }
          const last = pages.at(-1)!
          ;(last.page as { rows: unknown[] }).rows.push({
            label: toSlideSegs(row.label),
            body: toSlideSegs(row.body),
          })
          last.marks.push(...marks(row.body))
          used += height
        }
      }
      pages.at(-1)!.notes.push(...notes.map((item) => item.segs))
      pages[0].lead = lead
    } else {
      let used = PER_SLIDE
      for (const item of section.items) {
        if (item.type === 'table') {
          const cells = item.rows.map((row) =>
            row.map((lines) => lines.map((line) => plain(line)).join('\n')),
          )
          const colW = fitColumns(
            cells[0].map(
              (_, j) => Math.max(...item.rows.map((row) => cellWidth(row[j]))) * UNIT(14) + 0.3,
            ),
            DECK.w,
          )
          const heights = cells.map(
            (row) =>
              Math.max(
                ...row.map((text, j) =>
                  text
                    .split('\n')
                    .reduce(
                      (sum, line) =>
                        sum +
                        Math.max(1, Math.ceil((textWidth(line) * UNIT(14)) / (colW[j] - 0.3))),
                      0,
                    ),
                ),
              ) *
                CELL_LINE +
              0.16,
          )
          // 表格前只有一两段短文字（不带项目符号）时，文字作引导语与表格同页，不留只有两行的前一页
          const prev = pages.at(-1)
          const before =
            prev?.page.layout === 'bullets' &&
            prev.page.lines.length &&
            prev.page.lines.every((line) => line.bullet === undefined && !line.level) &&
            leadHeight(prev.page.lines.map((line) => line.segs)) <= 1.6
              ? pages.pop()
              : undefined
          const lead =
            before?.page.layout === 'bullets' ? before.page.lines.map((line) => line.segs) : []
          let limit = DECK.height - leadHeight(lead)
          let chunk: string[][] = []
          let height = heights[0]
          const flush = () => {
            const first = limit < DECK.height
            pages.push({
              page: { layout: 'table', rows: [cells[0], ...chunk], colW, align: item.align },
              ...(first && { lead }),
              notes: first ? (before?.notes ?? []) : [],
              marks: [...(first ? (before?.marks ?? []) : []), ...cellMarks(chunk)],
            })
            limit = DECK.height
          }
          cells.slice(1).forEach((row, k) => {
            if (chunk.length && height + heights[k + 1] > limit) {
              flush()
              chunk = []
              height = heights[0]
            }
            chunk.push(row)
            height += heights[k + 1]
          })
          flush()
          used = PER_SLIDE
          continue
        }
        const chars = Array.from(plain(item.segs))
        if (item.quote) {
          if (!pages.length) {
            pages.push({ page: { layout: 'bullets', lines: [] }, notes: [], marks: [] })
            used = 0
          }
          pages.at(-1)!.notes.push(item.segs)
          pages.at(-1)!.marks.push(...marks(item.segs))
          used += 0.6 * Math.ceil(chars.length / 80)
          continue
        }
        // 超过一页的长段按字数切开，切开的部分不保留行内格式
        const pieces =
          chars.length > PER_LINE * PER_SLIDE
            ? Array.from({ length: Math.ceil(chars.length / (PER_LINE * PER_SLIDE)) }, (_, i) => [
                {
                  text: chars
                    .slice(i * PER_LINE * PER_SLIDE, (i + 1) * PER_LINE * PER_SLIDE)
                    .join(''),
                },
              ])
            : [item.segs]
        pieces.forEach((piece, i) => {
          const cost = Math.ceil(Array.from(plain(piece)).length / PER_LINE)
          const last = pages.at(-1)
          if (!last || last.page.layout !== 'bullets' || used + cost > PER_SLIDE) {
            pages.push({ page: { layout: 'bullets', lines: [] }, notes: [], marks: [] })
            used = 0
          }
          const { page, marks: numbers } = pages.at(-1)!
          ;(page as { lines: unknown[] }).lines.push({
            segs: toSlideSegs(piece),
            level: Math.min(Math.max(item.depth - 1, 0), MAX_LEVEL),
            ...(item.mark && !i && { bullet: item.mark.ordered ? item.mark.n : true }),
          })
          numbers.push(...marks(piece))
          used += cost
        })
      }
    }
    if (!pages.length) pages.push({ page: { layout: 'bullets', lines: [] }, notes: [], marks: [] })
    pages[0].notes.unshift(...carried)
    carried = []
    pages.forEach(({ page, lead, notes, marks: numbers }, i) =>
      plan.push({
        ...page,
        kicker,
        title: i ? `${section.title}（续）` : section.title,
        ...(lead?.length && { lead: lead.map(toSlideSegs) }),
        notes: notes.filter((note) => !citeOnly(note)).map(toSlideSegs),
        foot: foot([...numbers, ...(lead ?? []).flatMap(marks), ...notes.flatMap(marks)]),
      } as SlidePlan),
    )
  })
  if (sources.length) {
    const lines = sources.map((item, i) => ({
      segs: [{ text: `[${i + 1}] ${source(item)}` }],
      level: 0,
    }))
    const PER = 9
    for (let i = 0; i < lines.length; i += PER)
      plan.push({
        layout: 'sources',
        kicker: '',
        title: i ? '引用来源（续）' : '引用来源',
        notes: [],
        foot: '',
        lines: lines.slice(i, i + PER),
      })
  }
  return plan
}

/** 按 deckPlan 的分页写出 .pptx；各版式的画法与 DESIGN.md“生成文件版式”一致 */
async function writeDeck(plan: SlidePlan[], title: string) {
  // TypeScript 把该包的类型声明当作 CommonJS；Node 按 ESM 加载时默认导出即是类
  const deck = new (PptxGenJS as unknown as typeof PptxGenJS.default)()
  Object.assign(deck, {
    layout: 'LAYOUT_WIDE',
    title,
    subject: title,
    author: '管策智研',
    company: '管策智研',
  })
  type Run = { text: string; options: Record<string, unknown> }
  // 段落属性只写在首段：pptxgenjs 遇到带项目符号的文字段会另起一段
  const runs = (segs: SlideSeg[], paragraph: Record<string, unknown> = {}): Run[] =>
    segs.map((seg, k) => ({
      text: seg.text,
      options: {
        bold: seg.bold,
        italic: seg.italics,
        strike: seg.strike ? 'sngStrike' : undefined,
        hyperlink: seg.link ? { url: seg.link } : undefined,
        ...(seg.sup && { superscript: true, color: RED }),
        ...(!k && paragraph),
        ...(k === segs.length - 1 && { breakLine: true }),
      },
    }))
  type Slide = ReturnType<typeof deck.addSlide>
  // lang 设为中文，PowerPoint 才按中文禁则断行（不让“、）”落到行首）
  const text = (slide: Slide, value: string | Run[], options: Record<string, unknown>) =>
    slide.addText(value as Run[], {
      fontFace: DECK.font,
      color: DECK.ink,
      margin: 0,
      isTextBox: true,
      lang: 'zh-CN',
      ...options,
    })
  for (const page of plan) {
    const slide = deck.addSlide()
    if (page.layout === 'cover') {
      slide.background = { color: DECK.dark }
      text(slide, '汇报材料', {
        x: 0.8,
        y: 1.2,
        w: 6,
        h: 0.4,
        fontSize: 14,
        color: 'E07A72',
        charSpacing: 4,
      })
      text(slide, page.title, {
        x: 0.8,
        y: 1.8,
        w: 11.7,
        h: 2.2,
        fontSize: textWidth(page.title) > 44 ? 32 : 40,
        bold: true,
        color: 'FFFFFF',
        valign: 'top',
      })
      if (page.subtitle)
        text(slide, page.subtitle, {
          x: 0.8,
          y: 4.15,
          w: 11.7,
          h: 0.6,
          fontSize: 20,
          color: 'C9C9CE',
        })
      if (page.lines.length)
        text(
          slide,
          page.lines.flatMap((line) => runs(line)),
          {
            x: 0.8,
            y: 5.1,
            w: 11.7,
            h: 1.8,
            fontSize: 12,
            color: '9A9AA0',
            valign: 'top',
            paraSpaceAfter: 2,
          },
        )
      continue
    }
    slide.slideNumber = {
      x: 12.1,
      y: 7.0,
      w: 0.8,
      h: 0.3,
      fontFace: DECK.font,
      fontSize: 10,
      color: DECK.mute,
      align: 'right',
    }
    // 没有正文的标题放在页面中部，作章节过渡页
    const empty = 'lines' in page && !page.lines.length
    text(
      slide,
      [
        ...(page.kicker
          ? [
              {
                text: page.kicker,
                options: { fontSize: 12, bold: false, color: RED, breakLine: true },
              },
            ]
          : []),
        { text: page.title, options: {} },
      ],
      {
        x: DECK.x,
        y: empty ? 2.4 : 0.3,
        w: DECK.w,
        h: empty ? 1.4 : 0.95,
        fontSize: empty ? 32 : 28,
        bold: true,
        valign: 'bottom',
      },
    )
    // 引导语在正文上方，正文从其下排起
    const lead = page.lead ?? []
    const top = DECK.top + leadHeight(lead)
    const room = DECK.height - leadHeight(lead)
    if (lead.length)
      text(
        slide,
        lead.flatMap((line) => runs(line)),
        {
          x: DECK.x,
          y: DECK.top,
          w: DECK.w,
          h: leadHeight(lead) - 0.08,
          fontSize: 15,
          valign: 'top',
          paraSpaceAfter: 4,
        },
      )
    if (page.layout === 'rows' && page.rows.length === 1) {
      // 只有一条：标签作朱红小标题，说明放大，免得整页只用上方一行
      const [row] = page.rows
      text(slide, runs(row.label), {
        x: DECK.x,
        y: top + 0.2,
        w: DECK.w,
        h: 0.5,
        fontSize: 16,
        bold: true,
        color: RED,
      })
      text(slide, runs(row.body), {
        x: DECK.x,
        y: top + 0.85,
        w: DECK.w,
        h: room - 1.0,
        fontSize: 22,
        valign: 'top',
      })
    } else if (page.layout === 'rows') {
      const labelW = labelWidth(page.rows)
      const heights = page.rows.map((row) => rowHeight(row, labelW))
      // 行少时把剩余高度匀给各行（每行至多加 0.6 英寸），版面不只用上方几行
      const extra = Math.min(0.6, (room - heights.reduce((a, b) => a + b, 0)) / heights.length)
      let y = top
      page.rows.forEach((row, i) => {
        const height = heights[i] + Math.max(0, extra)
        if (i)
          slide.addShape('line', {
            x: DECK.x,
            y,
            w: DECK.w,
            h: 0,
            line: { color: DECK.line, width: 0.75 },
          })
        text(slide, runs(row.label), {
          x: DECK.x,
          y: y + 0.13,
          w: labelW,
          h: height - 0.13,
          fontSize: 15,
          bold: true,
          valign: 'top',
        })
        text(slide, runs(row.body), {
          x: DECK.x + labelW + 0.3,
          y: y + 0.13,
          w: DECK.w - labelW - 0.3,
          h: height - 0.13,
          fontSize: 14,
          color: DECK.sub,
          valign: 'top',
        })
        y += height
      })
    } else if (page.layout === 'cards') {
      const width = (DECK.w - 0.3 * (page.rows.length - 1)) / page.rows.length
      const { label, height } = cardSize(page.rows, room)
      page.rows.forEach((row, i) => {
        const x = DECK.x + i * (width + 0.3)
        const y = top + 0.1
        slide.addShape('roundRect', {
          x,
          y,
          w: width,
          h: height,
          fill: { color: DECK.card },
          line: { color: DECK.card },
          rectRadius: 0.08,
        })
        slide.addShape('ellipse', {
          x: x + 0.3,
          y: y + 0.3,
          w: 0.5,
          h: 0.5,
          fill: { color: RED },
          line: { color: RED },
        })
        text(slide, String(i + 1), {
          x: x + 0.3,
          y: y + 0.3,
          w: 0.5,
          h: 0.5,
          fontSize: 16,
          bold: true,
          color: 'FFFFFF',
          align: 'center',
          valign: 'middle',
        })
        text(slide, runs(row.label), {
          x: x + 0.3,
          y: y + 1.0,
          w: width - 0.6,
          h: label,
          fontSize: 18,
          bold: true,
          valign: 'top',
        })
        text(slide, runs(row.body), {
          x: x + 0.3,
          y: y + 1.0 + label + 0.15,
          w: width - 0.6,
          h: height - label - 1.45,
          fontSize: 14,
          color: DECK.sub,
          valign: 'top',
        })
      })
    } else if (page.layout === 'table') {
      const wide = page.rows[0].length >= 3
      slide.addTable(
        page.rows.map((row, r) =>
          row.map((value, j) => ({
            text: value,
            options: !r
              ? { align: 'center', bold: true, color: 'FFFFFF', fill: { color: DECK.deep } }
              : wide && !j
                ? { align: page.align[j] ?? 'left', bold: true, fill: { color: DECK.card } }
                : { align: page.align[j] ?? 'left' },
          })),
        ),
        {
          x: DECK.x,
          y: top,
          w: DECK.w,
          colW: page.colW,
          fontFace: DECK.font,
          fontSize: 14,
          color: DECK.ink,
          valign: 'middle',
          margin: [0.06, 0.12, 0.06, 0.12],
          border: { type: 'solid', pt: 0.75, color: DECK.line },
        },
      )
    } else if (page.lines.length)
      text(
        slide,
        page.lines.flatMap((line) =>
          runs(line.segs, {
            bullet:
              line.bullet === undefined
                ? false
                : line.bullet === true
                  ? true
                  : { type: 'number', numberStartAt: line.bullet },
            indentLevel: line.level,
          }),
        ),
        {
          x: DECK.x,
          y: top,
          w: DECK.w,
          h: room,
          fontSize: page.layout === 'sources' ? 13 : 15,
          valign: 'top',
          paraSpaceAfter: 6,
        },
      )
    if (page.notes.length)
      text(
        slide,
        page.notes.flatMap((line) => runs(line)),
        {
          x: DECK.x,
          y: 6.45,
          w: DECK.w,
          h: 0.45,
          fontSize: 11,
          color: DECK.sub,
          valign: 'bottom',
        },
      )
    if (page.foot)
      text(slide, page.foot, {
        x: DECK.x,
        y: 6.95,
        w: 11.3,
        h: 0.4,
        fontSize: 10,
        color: DECK.mute,
        valign: 'top',
      })
  }
  return (await deck.write({ outputType: 'nodebuffer' })) as Buffer
}

export class Artifacts {
  store: Store
  library: LibraryStore
  constructor(store: Store) {
    this.store = store
    this.library = new LibraryStore(store)
  }
  /** 片段所属文献（标题与文献编号）、片段序号与章节，与界面原文片段栏同样的写法；片段不在库里时为 undefined */
  cite(id: string) {
    try {
      const passage = this.library.passage(id)
      // 标题去掉汉字之间的空白（源库标题常有分行留下的空格）；章节路径去掉 Markdown 标题符号，同前端 headingPath
      const title = passage.title
        .replace(/(?<=[㐀-鿿])\s+(?=[㐀-鿿])/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      return {
        doc: `《${title}》 文献编号 ${passage.documentId}`,
        part: String(passage.ordinal + 1),
        heading: passage.heading.replace(/(^|\/\s*)#+\s+/g, '$1'),
      }
    } catch (error) {
      if (error instanceof HttpError) return
      throw error
    }
  }
  /** 引用来源的一条：文献、片段序号与章节；片段不在库里时沿用链接文字与片段编号 */
  source({ id, label }: Source) {
    const found = this.cite(id)
    return found
      ? `${found.doc} · 片段 ${found.part}${found.heading ? ` · ${found.heading}` : ''}`
      : `${label}　片段 ${id}`
  }
  path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, '没有找到文件。')
    return join(this.store.root, 'artifacts', id)
  }
  async create(
    userId: string,
    sessionId: string,
    name: string,
    format: GeneratedFormat,
    content: string,
    signal?: AbortSignal,
  ) {
    this.store.session(userId, sessionId)
    if (
      !Object.hasOwn(MIME, format) ||
      !name.trim() ||
      name.length > 100 ||
      /[/\\]/.test(name) ||
      Array.from(name).some((char) => char.charCodeAt(0) < 32) ||
      // 文件名会写进 Office 文件的标题、页眉和工作表名
      xmlInvalid(name)
    )
      throw new HarnessError('文件名称或格式无效。', 'FILE_INVALID_NAME')
    if (!content.trim() || Buffer.byteLength(content) > MAX_CONTENT)
      throw new HarnessError('文件内容为空或超过 200 KB。', 'FILE_INVALID_CONTENT')
    // Windows 下载时浏览器把文件名里的 " 换成 _，改用中文引号
    const title = name
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/"([^"]*)"/g, '“$1”')
      .replaceAll('"', '”')
    if ((format === 'docx' || format === 'pptx') && xmlInvalid(content))
      throw new HarnessError(
        `${format === 'docx' ? 'Word ' : '演示文稿'}正文含有不支持的字符，请移除无效字符或改用 Markdown。`,
        `FILE_INVALID_${format.toUpperCase()}_CONTENT`,
      )
    let bytes: Buffer
    // Office 文件保留生成时的原文供在线预览：docx 为 Markdown，pptx 为分页结果（见下），xlsx 为 CSV
    let preview = format === 'docx' ? content : undefined
    const source = (item: Source) => this.source(item)
    if (format === 'docx') bytes = await docx(content, title, source)
    else if (format === 'pptx') {
      const plan = deckPlan(content, title, source, (id) => this.cite(id))
      bytes = await writeDeck(plan, (plan[0] as { title: string }).title)
      // 在线预览与导出文件用同一份分页
      preview = JSON.stringify({ slides: plan })
    } else if (format === 'xlsx' || format === 'csv') {
      // 二维 JSON 数组；也接受按行写的 JSON 数组（JSON Lines）和 Markdown 表格（取第一张）。
      // 都不是时给出下面的格式说明，而不是笼统的“工具执行失败”
      let rows: unknown
      try {
        rows = JSON.parse(content)
      } catch {
        try {
          rows = content
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line))
        } catch {
          const table = flatten(content, 'FILE_INVALID_TABLE').items.find(
            (item) => item.type === 'table',
          )
          // 表格没有文末来源页，引用编号就地写成文献名
          rows = table?.rows.map((row) =>
            row.map((lines) =>
              lines
                .map((line) =>
                  line
                    .map((seg, k) =>
                      seg.source ? `${k ? ' ' : ''}${source(seg.source)}` : seg.text,
                    )
                    .join(''),
                )
                .join('\n'),
            ),
          )
        }
      }
      if (
        !Array.isArray(rows) ||
        rows.length > MAX_ROWS ||
        !rows.every(
          (row) =>
            Array.isArray(row) &&
            row.length <= MAX_COLUMNS &&
            row.every(
              (cell) =>
                typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell)),
            ),
        )
      )
        throw new HarnessError(
          '表格内容必须为二维 JSON 数组或 Markdown 表格，最多 2000 行、50 列，单元格仅支持文本或数字。',
          'FILE_INVALID_TABLE',
        )
      // JSON 写法的单元格不经 Markdown 解析，其中的文献库原文链接同样就地写成文献名
      for (const row of rows)
        for (const [k, cell] of row.entries())
          if (typeof cell === 'string')
            row[k] = cell.replace(
              CELL_CITE,
              (_, label: string, id: string, at: number) =>
                `${at ? ' ' : ''}${source({ id: id.toLowerCase(), label })}`,
            )
      if (format === 'xlsx') {
        if (
          rows.some((row) =>
            row.some((cell: unknown) => typeof cell === 'string' && xmlInvalid(cell)),
          )
        )
          throw new HarnessError(
            '表格含有 Excel 不支持的字符，请移除无效字符或改用 CSV。',
            'FILE_INVALID_XLSX_CONTENT',
          )
        const book = new ExcelJS.Workbook()
        const columns = Math.max(0, ...rows.map((row) => row.length))
        // 工作表以文件名命名：去掉 Excel 不允许的字符、截到 31 个字符；为空、是保留名或截出半个代理对时用默认名
        const sheetName = title.replace(/[\\/?*[\]:']/g, '').slice(0, 31)
        // 横向 A4、适应一页宽，每页重复表头，页眉为标题、页脚为页码
        const sheet = book.addWorksheet(
          sheetName && sheetName.isWellFormed() && !/^history$/i.test(sheetName)
            ? sheetName
            : '研究资料',
          {
            views: [{ state: 'frozen', ySplit: 1 }],
            pageSetup: {
              paperSize: 9,
              orientation: 'landscape',
              fitToPage: true,
              fitToWidth: 1,
              fitToHeight: 0,
              printTitlesRow: '1:1',
            },
            headerFooter: {
              oddHeader: `&C${title.replaceAll('&', '&&')}`,
              oddFooter: '&C第 &P 页 / 共 &N 页',
            },
          },
        )
        sheet.addRows(
          rows.map((row, i) =>
            row.map((cell: string | number) =>
              typeof cell !== 'string'
                ? cell
                : // 表头以下的纯数字文本存为数值（不超过 9 位整数、无前导零与小数尾零，转换后显示不变），
                  // 免得 Excel 标“以文本形式存储的数字”；其余文字原样
                  i && /^-?(0|[1-9]\d{0,8})(\.\d{0,5}[1-9])?$/.test(cell)
                  ? Number(cell)
                  : // ExcelJS decodes OOXML escapes when reading but does not escape literal text on write.
                    cell.replace(/_(?=x[0-9a-fA-F]{4}_)/g, '_x005F_'),
            ),
          ),
        )
        if (columns)
          sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns } }
        // 首行为表头：加粗、底色、冻结、筛选；各列按最长一行定宽（8–50 字符宽，超出换行），细边框
        const thin = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } }
        for (let j = 1; j <= columns; j++) {
          const [head, body] = [rows.slice(0, 1), rows.slice(1)].map((part) =>
            Math.max(
              0,
              ...part.flatMap((row) =>
                String(row[j - 1] ?? '')
                  .split('\n')
                  .map(textWidth),
              ),
            ),
          )
          // 表头另留出筛选按钮的位置；内容短的列居中
          sheet.getColumn(j).width = Math.min(50, Math.max(8, head + 4, body + 2))
          for (let i = 1; i <= rows.length; i++) {
            const cell = sheet.getCell(i, j)
            cell.border = { top: thin, left: thin, bottom: thin, right: thin }
            cell.alignment = {
              vertical: i === 1 ? 'middle' : 'top',
              horizontal: i === 1 || body <= 8 ? 'center' : undefined,
              wrapText: true,
            }
            if (i === 1) {
              cell.font = { bold: true }
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } }
            }
          }
        }
        bytes = Buffer.from(await book.xlsx.writeBuffer())
        // 预览用的 CSV 保留单元格原值，与 Excel 中显示的一致
        preview = csv(rows, false)
      } else bytes = Buffer.from('\uFEFF' + csv(rows, true), 'utf8')
    } else bytes = Buffer.from(content)
    signal?.throwIfAborted()
    const filename = title + '.' + format
    return this.save(userId, sessionId, filename, bytes, signal, true, preview)
  }
  async save(
    userId: string,
    sessionId: string,
    name: string,
    bytes: Buffer,
    signal?: AbortSignal,
    generated = false,
    preview?: string,
  ) {
    this.store.session(userId, sessionId)
    if (
      !name.trim() ||
      name.length > 200 ||
      /[/\\]/.test(name) ||
      Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      bytes.length > MAX_USER_BYTES
    )
      throw new HarnessError('文件名称无效或文件超过 50 MiB。', 'FILE_TOO_LARGE')
    signal?.throwIfAborted()
    const extension = extname(name).slice(1).toLowerCase()
    const artifact: Artifact = {
      id: randomUUID(),
      sessionId,
      name,
      format: /^[a-z0-9]{1,12}$/.test(extension) ? extension : 'bin',
      size: bytes.length,
    }
    await mkdir(join(this.store.root, 'artifacts'), { recursive: true, mode: 0o700 })
    try {
      await writeFile(this.path(artifact.id), bytes, { flag: 'wx', mode: 0o600, signal })
      signal?.throwIfAborted()
      // Check after the await: concurrent generations cannot bypass the quota.
      // 预览原文存在数据库里，同样计入配额
      const used = this.store.db
        .prepare(
          `SELECT COALESCE(SUM(a.size + COALESCE(LENGTH(CAST(a.preview AS BLOB)), 0)), 0) AS size FROM artifacts a JOIN sessions s ON a.session_id=s.id WHERE s.user_id=?`,
        )
        .get(userId) as { size: number }
      if (used.size + bytes.length + Buffer.byteLength(preview ?? '') > MAX_USER_BYTES)
        throw new HarnessError('文件空间已达上限，请联系管理员。', 'FILE_QUOTA')
      this.store.addArtifact(userId, artifact, generated, preview)
    } catch (error) {
      await unlink(this.path(artifact.id)).catch(() => {})
      throw error
    }
    return artifact
  }
  async read(
    userId: string,
    sessionId: string,
    id: string,
    workspace?: Workspace,
    signal?: AbortSignal,
  ) {
    const file = this.store.artifact(userId, id)
    if (file.sessionId !== sessionId)
      throw new HarnessError('只能读取当前会话的文件。', 'FILE_SESSION_ONLY')
    const data = await readFile(this.path(id))
    if (
      (file.format === 'docx' || file.format === 'xlsx') &&
      !this.store.generatedArtifact(userId, id)
    ) {
      if (!workspace)
        throw new HarnessError(
          '外部生成的 Office 文件需要在会话沙箱中读取，请先配置沙箱服务。',
          'FILE_SANDBOX_REQUIRED',
        )
      return workspace.readOffice(data, file.format, signal)
    }
    let text: string
    if (file.format === 'xlsx') {
      const book = new ExcelJS.Workbook()
      await book.xlsx.load(Uint8Array.from(data).buffer)
      text = JSON.stringify(book.worksheets[0]?.getSheetValues())
    } else if (file.format === 'docx') {
      const zip = await JSZip.loadAsync(data)
      const xml = await zip.file('word/document.xml')!.async('string')
      const parsed: unknown = new XMLParser({
        preserveOrder: true,
        parseTagValue: false,
        trimValues: false,
      }).parse(xml)
      const collect = (node: unknown): string => {
        if (Array.isArray(node)) return node.map(collect).join('')
        if (!node || typeof node !== 'object') return ''
        return Object.entries(node)
          .map(([key, value]) =>
            key === '#text' ? String(value) : collect(value) + (key === 'w:p' ? '\n' : ''),
          )
          .join('')
      }
      text = collect(parsed)
    } else {
      if (data.includes(0))
        throw new HarnessError('这是二进制文件，请使用沙箱工具处理或下载。', 'FILE_BINARY')
      text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    }
    return text.length > 32000 ? text.slice(0, 32000) + '\n[内容已截断]' : text
  }
  register(ctx: Context, userId: string, sessionId: string, workspace?: Workspace) {
    ctx.tools.register(
      defineTool({
        name: 'create_file',
        description:
          '生成当前会话的文件供下载。md/docx/pptx 的 content 为 Markdown，docx 与 pptx 排版其中的 # 至 #### 标题、段落、- 或 1. 列表（可缩进一级）、**加粗**、| 表格 | 和 > 引用，文献库原文链接转为上标编号并在文末列出引用来源：docx 以开头的 # 标题为文档标题；pptx 为演示文稿（PPT），开头的 # 标题作封面，其后每个标题开一页，表格单独成页，过长自动分页。xlsx/csv 的 content 为二维 JSON 数组字符串或 Markdown 表格，第一行为表头。不要编造研究结果或数据。',
        parameters: {
          name: { type: 'string', required: true },
          format: { type: 'string', enum: ['md', 'docx', 'pptx', 'xlsx', 'csv'], required: true },
          content: { type: 'string', required: true },
        },
        output: contentOutput,
        execute: async (args, exec) => {
          const artifact = await this.create(
            userId,
            sessionId,
            args.name,
            args.format,
            args.content,
            exec.signal,
          ).catch(rethrowStopped(exec.signal))
          // 回复紧跟工具结果写：只靠系统提示时，模型常把出处只写进文件、对话里只写文献编号
          return JSON.stringify(
            /\/api\/library\/passages\//.test(args.content)
              ? { ...artifact, note: FILE_REPLY }
              : artifact,
          )
        },
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'list_files',
        description: '列出当前会话生成的文件。',
        parameters: {},
        output: contentOutput,
        execute: async () => JSON.stringify(this.store.artifacts(userId, sessionId)),
      }),
    )
    ctx.tools.register(
      defineTool({
        name: 'read_file',
        description: '读取当前会话生成文件的文本，最多返回 32000 字符。',
        parameters: { id: { type: 'string', required: true } },
        output: contentOutput,
        execute: (args, exec) =>
          this.read(userId, sessionId, args.id, workspace, exec.signal).catch(
            rethrowStopped(exec.signal),
          ),
      }),
    )
  }
}
