import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { Document, HeadingLevel, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Artifact } from '../src/types/index.ts'
import { Store, HttpError } from './store.ts'

export const MIME: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const MAX_CONTENT = 200_000
const MAX_USER_BYTES = 50 * 1024 * 1024
type GeneratedFormat = 'md' | 'docx' | 'xlsx' | 'csv'
type Workspace = { writeFile(name: string, data: Uint8Array, signal?: AbortSignal): Promise<void> }
const contentOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
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
    workspace?: Workspace,
  ) {
    this.store.session(userId, sessionId)
    if (
      !Object.hasOwn(MIME, format) ||
      !name.trim() ||
      name.length > 100 ||
      /[/\\]/.test(name) ||
      Array.from(name).some((char) => char.charCodeAt(0) < 32)
    )
      throw new Error('文件名称或格式无效。')
    if (!content.trim() || Buffer.byteLength(content) > MAX_CONTENT)
      throw new Error('文件内容为空或超过 200 KB。')
    let bytes: Buffer
    if (format === 'docx') {
      const children = content.split(/\r?\n/).map((line) => {
        const heading = /^(#{1,3})\s+(.+)$/.exec(line)
        return new Paragraph(
          heading
            ? {
                text: heading[2],
                heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
                  heading[1].length - 1
                ],
              }
            : { text: line },
        )
      })
      bytes = await Packer.toBuffer(new Document({ sections: [{ children }] }))
    } else if (format === 'xlsx' || format === 'csv') {
      const rows: unknown = JSON.parse(content)
      if (
        !Array.isArray(rows) ||
        rows.length > 2000 ||
        !rows.every(
          (row) =>
            Array.isArray(row) &&
            row.length <= 50 &&
            row.every(
              (cell) =>
                typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell)),
            ),
        )
      )
        throw new Error(
          '表格内容必须为二维 JSON 数组，最多 2000 行、50 列，单元格仅支持文本或数字。',
        )
      if (format === 'xlsx') {
        const book = new ExcelJS.Workbook()
        const sheet = book.addWorksheet('研究资料')
        sheet.addRows(rows)
        sheet.getRow(1).font = { bold: true }
        sheet.columns.forEach((col) => {
          col.width = 24
        })
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
    const filename = name.replace(/\.[a-z0-9]+$/i, '') + '.' + format
    await workspace?.writeFile(filename, bytes, signal)
    return this.save(userId, sessionId, filename, bytes, signal)
  }
  async save(userId: string, sessionId: string, name: string, bytes: Buffer, signal?: AbortSignal) {
    this.store.session(userId, sessionId)
    if (
      !name.trim() ||
      name.length > 200 ||
      /[/\\]/.test(name) ||
      Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      bytes.length > MAX_USER_BYTES
    )
      throw new Error('文件名称无效或文件超过 50 MiB。')
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
        throw new Error('文件空间已达上限，请联系管理员。')
      this.store.addArtifact(userId, artifact)
    } catch (error) {
      await unlink(this.path(artifact.id)).catch(() => {})
      throw error
    }
    return artifact
  }
  async read(userId: string, sessionId: string, id: string) {
    const file = this.store.artifact(userId, id)
    if (file.sessionId !== sessionId) throw new Error('只能读取当前会话的文件。')
    const data = await readFile(this.path(id))
    let text: string
    if (file.format === 'xlsx') {
      const book = new ExcelJS.Workbook()
      await book.xlsx.load(Uint8Array.from(data).buffer)
      text = JSON.stringify(book.worksheets[0]?.getSheetValues())
    } else if (file.format === 'docx') {
      const zip = await JSZip.loadAsync(data)
      const xml = await zip.file('word/document.xml')!.async('string')
      const parsed: unknown = new XMLParser({ preserveOrder: true, parseTagValue: false }).parse(
        xml,
      )
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
      if (data.includes(0)) throw new Error('这是二进制文件，请使用沙箱工具处理或下载。')
      text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    }
    return text.length > 32000 ? text.slice(0, 32000) + '\n[内容已截断]' : text
  }
  register(ctx: Context, userId: string, sessionId: string, workspace?: Workspace) {
    ctx.tools.register(
      defineTool({
        name: 'create_file',
        description:
          '生成当前会话的文件供下载。md/docx 的 content 为正文（docx 支持 # 标题与段落）；xlsx/csv 的 content 必须为二维 JSON 数组字符串，第一行为表头。不要编造研究结果或数据。',
        parameters: {
          name: { type: 'string', required: true },
          format: { type: 'string', enum: ['md', 'docx', 'xlsx', 'csv'], required: true },
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
              workspace,
            ),
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
        execute: (args) => this.read(userId, sessionId, args.id),
      }),
    )
  }
}
