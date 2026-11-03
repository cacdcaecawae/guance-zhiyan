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
import type { Artifact } from '../src/types/index.ts'
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
/** sup 为文献引用编号，code 为行内代码 */
type Seg = {
  text: string
  bold?: boolean
  italics?: boolean
  strike?: boolean
  link?: string
  sup?: boolean
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

const RED = 'B0302A'
const PASSAGE = /^\/api\/library\/passages\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i
const plain = (segs: Seg[]) => segs.map((seg) => seg.text).join('')
const cjk = /[㐀-鿿]/
/** 中文语境的直双引号换成弯引号：引号内含汉字才换；单引号常是英文撇号（China's），不动。替换前后长度不变 */
const curly = (text: string) =>
  text.replace(/"([^"\n]*)"/g, (match, inner: string) => (cjk.test(inner) ? `“${inner}”` : match))
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
 * 文献库原文链接只留文字，后附引用编号（同一片段同一编号），sources 按编号列出片段。
 * 正文过于复杂或解析失败时按 code 报错。 */
function flatten(content: string, code: string) {
  const items: Item[] = []
  const sources: { id: string; label: string }[] = []
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
        inline(node.children, web ? { ...style, link: node.url } : style, out)
        if (passage) {
          const n =
            sources.findIndex((source) => source.id === passage) + 1 ||
            sources.push({ id: passage, label: plain(tidy(inline(node.children).flat())) })
          out.at(-1)!.push({ text: `[${n}]`, sup: true })
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
    for (const segs of lines)
      if (segs.length) {
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
 * 一级章节不少于 3 个的长报告加封面，标题与首个章节前的说明放在封面上。文末列出引用来源。 */
function docx(content: string, name: string) {
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
              (source, i) =>
                new Paragraph({
                  style: 'Source',
                  children: [new TextRun(`[${i + 1}]\t${source.label}　片段 ${source.id}`)],
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

export class Artifacts {
  store: Store
  constructor(store: Store) {
    this.store = store
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
    if (format === 'docx') bytes = await docx(content, title)
    else if (format === 'pptx') {
      // 与 Word 同样解析 Markdown：每个标题开一页，其下文字行与表格归该页，列表项显示项目符号或编号，
      // > 引用作页底注；文献引用编号列在末页“引用来源”。
      type Section = { title: string; level: number; items: Exclude<Item, { type: 'heading' }>[] }
      const { items, sources } = flatten(content, 'FILE_INVALID_PPTX_CONTENT')
      const sections: Section[] = [{ title, level: 0, items: [] }]
      for (const item of items) {
        if (item.type === 'heading')
          sections.push({ title: plain(item.segs).trim(), level: item.depth, items: [] })
        else if (item.type === 'table' || plain(item.segs).trim()) sections.at(-1)!.items.push(item)
      }
      if (!sections[0].items.length) sections.shift()
      // 封面：开头的 # 标题（正文另有其他 # 标题且它下面有正文时用文件名），紧跟的破折号标题作副标题，
      // 两者下面不长的文字（如依据文献）也放在封面
      let cover = title
      let subtitle = ''
      let coverItems: Section['items'] = []
      if (
        sections[0]?.level === 1 &&
        (!sections[0].items.length || sections.filter((s) => s.level === 1).length === 1)
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
      if (sources.length)
        sections.push({
          title: '引用来源',
          level: 0,
          items: sources.map((source, i) => ({
            type: 'line',
            segs: [{ text: `[${i + 1}] ${source.label}　片段 ${source.id}` }],
            depth: 0,
            quote: false,
          })),
        })
      // ponytail: 按每行 44 字、每页 14 行估算分页（18 磅微软雅黑实测约 47 个汉字一行、正文框约 16 行），
      // 西文与长单词按字数计偏保守；要更满的版面再按字体测宽
      const PER_LINE = 44
      const PER_SLIDE = 14
      // ponytail: 表格按 14 磅字宽估算各行行数与行高，单行高过整页时仍会超出页面；要精确再按字体测宽
      const CELL_UNIT = 14 / 72 / 2
      const CELL_LINE = (14 * 1.2) / 72
      const TABLE_HEIGHT = 5
      const fontFace = '微软雅黑'
      const font = { fontFace, color: '1B1B1D' }
      const grey = { fontFace, color: '7F7F7F' }
      const red = { color: RED }
      type Run = { text: string; options: Record<string, unknown> }
      // 段落属性只写在首段：pptxgenjs 遇到带项目符号的文字段会另起一段
      const toRuns = (segs: Seg[], paragraph: Record<string, unknown> = {}): Run[] =>
        segs.map((seg, k) => ({
          text: seg.text,
          options: {
            bold: seg.bold,
            italic: seg.italics,
            strike: seg.strike ? 'sngStrike' : undefined,
            hyperlink: seg.link ? { url: seg.link } : undefined,
            ...(seg.sup && { superscript: true, ...red }),
            ...(!k && paragraph),
            ...(k === segs.length - 1 && { breakLine: true }),
          },
        }))
      // TypeScript 把该包的类型声明当作 CommonJS；Node 按 ESM 加载时默认导出即是类
      const deck = new (PptxGenJS as unknown as typeof PptxGenJS.default)()
      Object.assign(deck, {
        layout: 'LAYOUT_WIDE',
        title: cover,
        subject: cover,
        author: '管策智研',
        company: '管策智研',
      })
      const first = deck.addSlide()
      first.addShape('rect', { x: 0, y: 0, w: 0.3, h: 7.5, fill: red, line: red })
      first.addText(cover, {
        x: 1,
        y: 1.2,
        w: 11.3,
        h: 2.6,
        fontSize: 36,
        bold: true,
        valign: 'bottom',
        ...font,
      })
      if (subtitle)
        first.addText(subtitle, { x: 1, y: 3.95, w: 11.3, h: 0.8, fontSize: 20, ...grey })
      if (coverItems.length)
        first.addText(
          coverItems.flatMap((item) => (item.type === 'line' ? toRuns(item.segs) : [])),
          { x: 1, y: 4.9, w: 11.3, h: 2, fontSize: 14, valign: 'top', paraSpaceAfter: 4, ...grey },
        )
      // 没有正文（至多只有引用注）、下一节层级更深的标题不单独成页，作章节名显示在其下各页标题上方
      const chapters: Section[] = []
      let carried: Run[] = []
      sections.forEach((section, s) => {
        while (chapters.length && chapters.at(-1)!.level >= section.level) chapters.pop()
        const quoteOnly = section.items.every((item) => item.type === 'line' && item.quote)
        if (quoteOnly && (sections[s + 1]?.level ?? 0) > section.level) {
          chapters.push(section)
          for (const item of section.items)
            if (item.type === 'line') carried.push(...toRuns(item.segs))
          return
        }
        // 每页为一组文字段（每行最后一段带 breakLine），或一段表格（首行为表头，每页重复）；notes 为页底注
        type Page = { notes: Run[] } & (
          { runs: Run[] } | { rows: string[][]; colW: number[]; align: Align }
        )
        const pages: Page[] = []
        let used = PER_SLIDE
        for (const item of section.items) {
          if (item.type === 'table') {
            const rows = item.rows.map((row) =>
              row.map((lines) => lines.map((line) => plain(line)).join('\n')),
            )
            const colW = fitColumns(
              rows[0].map(
                (_, j) => Math.max(...item.rows.map((row) => cellWidth(row[j]))) * CELL_UNIT + 0.3,
              ),
              12.1,
            )
            const heights = rows.map(
              (row) =>
                Math.max(
                  ...row.map((text, j) =>
                    text
                      .split('\n')
                      .reduce(
                        (sum, line) =>
                          sum +
                          Math.max(1, Math.ceil((textWidth(line) * CELL_UNIT) / (colW[j] - 0.2))),
                        0,
                      ),
                  ),
                ) *
                  CELL_LINE +
                0.1,
            )
            let page: string[][] = []
            let height = heights[0]
            rows.slice(1).forEach((row, k) => {
              if (page.length && height + heights[k + 1] > TABLE_HEIGHT) {
                pages.push({ rows: [rows[0], ...page], colW, align: item.align, notes: [] })
                page = []
                height = heights[0]
              }
              page.push(row)
              height += heights[k + 1]
            })
            pages.push({ rows: [rows[0], ...page], colW, align: item.align, notes: [] })
            used = PER_SLIDE
            continue
          }
          const chars = Array.from(plain(item.segs))
          if (item.quote) {
            // 页底注挂在当前页；按每行 80 字、约合 0.6 行正文占用版面
            if (!pages.length) {
              pages.push({ runs: [], notes: [] })
              used = 0
            }
            pages.at(-1)!.notes.push(...toRuns(item.segs))
            used += 0.6 * Math.ceil(chars.length / 80)
            continue
          }
          const { mark } = item
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
            if (!last || !('runs' in last) || used + cost > PER_SLIDE) {
              pages.push({ runs: [], notes: [] })
              used = 0
            }
            ;(pages.at(-1) as { runs: Run[] }).runs.push(
              ...toRuns(piece, {
                bullet:
                  mark && !i
                    ? mark.ordered
                      ? { type: 'number', numberStartAt: mark.n }
                      : true
                    : false,
                indentLevel: Math.min(Math.max(item.depth - 1, 0), MAX_LEVEL),
              }),
            )
            used += cost
          })
        }
        if (!pages.length) pages.push({ runs: [], notes: [] })
        pages[0].notes.unshift(...carried)
        carried = []
        const kicker = chapters.at(-1)?.title
        pages.forEach((page, i) => {
          const slide = deck.addSlide()
          slide.slideNumber = {
            x: 12.1,
            y: 7.0,
            w: 0.8,
            h: 0.3,
            fontSize: 10,
            align: 'right',
            ...grey,
          }
          // 没有正文的标题放在页面中部，作章节过渡页
          const top = 'rows' in page || page.runs.length ? 0.3 : 2.4
          slide.addText(
            [
              ...(kicker
                ? [{ text: kicker, options: { fontSize: 14, breakLine: true, ...red } }]
                : []),
              { text: i ? `${section.title}（续）` : section.title, options: {} },
            ],
            {
              x: 0.6,
              y: top,
              w: 12.1,
              h: 1,
              fontSize: top < 1 ? 24 : 32,
              bold: true,
              valign: 'bottom',
              ...font,
            },
          )
          slide.addShape('rect', { x: 0.7, y: top + 1.1, w: 1, h: 0.06, fill: red, line: red })
          if ('rows' in page)
            slide.addTable(
              page.rows.map((row, r) =>
                row.map((text, j) => ({
                  text,
                  options: r
                    ? { align: page.align[j] ?? 'left' }
                    : { align: 'center', bold: true, color: 'FFFFFF', fill: red },
                })),
              ),
              {
                x: 0.6,
                y: 1.65,
                w: 12.1,
                colW: page.colW,
                fontSize: 14,
                valign: 'middle',
                border: { type: 'solid', pt: 0.75, color: 'BFBFBF' },
                ...font,
              },
            )
          else if (page.runs.length)
            slide.addText(page.runs, {
              x: 0.6,
              y: 1.65,
              w: 12.1,
              h: 5,
              fontSize: 18,
              valign: 'top',
              paraSpaceAfter: 6,
              ...font,
            })
          if (page.notes.length)
            slide.addText(page.notes, {
              x: 0.6,
              y: 6.7,
              w: 11.4,
              h: 0.6,
              fontSize: 11,
              valign: 'bottom',
              ...grey,
            })
        })
      })
      bytes = (await deck.write({ outputType: 'nodebuffer' })) as Buffer
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
          rows = table?.rows.map((row) =>
            row.map((lines) =>
              lines.map((line) => plain(line.filter((seg) => !seg.sup))).join('\n'),
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
      } else {
        // Spreadsheet applications may execute formula-like CSV text.
        bytes = Buffer.from(
          '\uFEFF' +
            rows
              .map((row) =>
                (row as (string | number)[])
                  .map((cell) => {
                    const text =
                      typeof cell === 'string' && /^[\s]*[=+@-]/u.test(cell)
                        ? `'${cell}`
                        : String(cell)
                    return `"${text.replaceAll('"', '""')}"`
                  })
                  .join(','),
              )
              .join('\r\n'),
          'utf8',
        )
      }
    } else bytes = Buffer.from(content)
    signal?.throwIfAborted()
    const filename = title + '.' + format
    return this.save(userId, sessionId, filename, bytes, signal, true)
  }
  async save(
    userId: string,
    sessionId: string,
    name: string,
    bytes: Buffer,
    signal?: AbortSignal,
    generated = false,
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
      const used = this.store.db
        .prepare(
          `SELECT COALESCE(SUM(a.size), 0) AS size FROM artifacts a JOIN sessions s ON a.session_id=s.id WHERE s.user_id=?`,
        )
        .get(userId) as { size: number }
      if (used.size + bytes.length > MAX_USER_BYTES)
        throw new HarnessError('文件空间已达上限，请联系管理员。', 'FILE_QUOTA')
      this.store.addArtifact(userId, artifact, generated)
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
        execute: async (args, exec) =>
          JSON.stringify(
            await this.create(
              userId,
              sessionId,
              args.name,
              args.format,
              args.content,
              exec.signal,
            ).catch(rethrowStopped(exec.signal)),
          ),
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
