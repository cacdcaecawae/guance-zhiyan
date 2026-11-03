import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { XMLParser } from 'fast-xml-parser'
import JSZip from 'jszip'
import type { AssistantMessage, ModelSelection } from '../src/types/index.ts'
import type { ValsetJob, ValsetJobSummary, ValsetRow, ValsetStatus } from '../src/types/valset.ts'
import { splitAnswer } from '../src/features/workspace/tool-display.ts'
import type { Agents } from './agent.ts'
import { flatten, MIME } from './artifacts.ts'
import type { Identity } from './auth.ts'
import { modelCatalog } from './models.ts'
import { HttpError, type Store } from './store.ts'

const MAX_ROWS = 1000
const MAX_FILE = 10 * 2 ** 20
/** 与对话提问的上限一致 */
const MAX_QUESTION = 8000
const ANSWER_HEADER = /^(?:预期答案|参考答案)(?:[（(](?:预期答案|参考答案)[)）])?$/

/** 解压后单个部件的上限，挡住压缩炸弹 */
const MAX_PART = 64 * 2 ** 20
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
  // 解码 &#38382; 这类数字字符引用（openpyxl 把中文都写成这样）
  htmlEntities: true,
  isArray: (name, _path, _leaf, attribute) =>
    !attribute && ['Relationship', 'sheet', 'si', 'r', 'row', 'c'].includes(name),
})
/** 解析后的 XML 按路径取值，缺失时为 undefined */
const at = (node: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
    node,
  )
const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : [])
/** <t> 带属性（如 xml:space）时文字在 #text 里 */
const text = (node: unknown) => (typeof node === 'string' ? node : String(at(node, '#text') ?? ''))
/** 共享或行内字符串：一段 <t>，或富文本各段 <r><t> 相连（不含注音） */
const richText = (node: unknown) =>
  at(node, 't') !== undefined
    ? text(at(node, 't'))
    : list(at(node, 'r'))
        .map((run) => text(at(run, 't')))
        .join('')
const column = (ref: string) =>
  Array.from(/^[A-Z]+/.exec(ref)?.[0] ?? '').reduce(
    (n, char) => n * 26 + char.charCodeAt(0) - 64,
    0,
  )

/**
 * 首个工作表前两列的文字，按行号。直接读 OOXML，不用 ExcelJS：组委会模板由 openpyxl 生成（带批注、
 * 关系用绝对路径、行内字符串），ExcelJS 4.4 读取时抛错。
 */
async function readTable(data: ArrayBuffer) {
  const zip = await JSZip.loadAsync(data)
  const part = async (path: string | undefined) => {
    const file = path ? zip.file(path) : null
    if (!file) return undefined
    // ponytail: 解压前用 JSZip 内部记录的原始大小挡压缩炸弹；JSZip 改了内部字段时改为流式计数
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data
    if ((size?.uncompressedSize ?? 0) > MAX_PART) throw new HttpError(413, '文件解压后过大。')
    return xml.parse(await file.async('string')) as unknown
  }
  const rels = list(at(await part('xl/_rels/workbook.xml.rels'), 'Relationships', 'Relationship'))
  // 关系目标可写相对 xl/ 的路径或以 / 开头的包内绝对路径
  const target = (match: (rel: unknown) => boolean) => {
    const path = at(rels.find(match), 'Target')
    return typeof path === 'string'
      ? new URL(path, 'http://package/xl/').pathname.slice(1)
      : undefined
  }
  const sheet = at(await part('xl/workbook.xml'), 'workbook', 'sheets', 'sheet', 0, 'id')
  const sheetData = at(
    await part(target((rel) => at(rel, 'Id') === sheet)),
    'worksheet',
    'sheetData',
  )
  if (sheetData === undefined) throw new Error('没有工作表')
  const shared = list(
    at(
      await part(target((rel) => String(at(rel, 'Type')).endsWith('/sharedStrings'))),
      'sst',
      'si',
    ),
  ).map(richText)
  const table = new Map<number, string[]>()
  for (const row of list(at(sheetData, 'row'))) {
    const cells: string[] = []
    let index = 0
    for (const cell of list(at(row, 'c'))) {
      const ref = at(cell, 'r')
      index = typeof ref === 'string' ? column(ref) : index + 1
      if (index > 2) continue
      const type = at(cell, 't')
      const value = text(at(cell, 'v'))
      cells[index - 1] =
        type === 's'
          ? (shared[Number(value)] ?? '')
          : type === 'inlineStr'
            ? richText(at(cell, 'is'))
            : type === 'b'
              ? value === '1'
                ? 'TRUE'
                : 'FALSE'
              : value
    }
    table.set(Number(at(row, 'r')) || Math.max(0, ...table.keys()) + 1, cells)
  }
  return table
}

/** 读取上传的验证集：首个工作表，第一行表头“问题”“预期答案”，其后每行一题；问题为空的行跳过，其余列忽略。 */
export async function parseValset(data: ArrayBuffer) {
  let table: Map<number, string[]>
  try {
    table = await readTable(data)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, '无法读取文件，请上传 .xlsx 格式的验证集（.xls 请先另存为 .xlsx）。')
  }
  const header = (index: number) => (table.get(1)?.[index] ?? '').replace(/\s/g, '')
  if (header(0) !== '问题' || !ANSWER_HEADER.test(header(1)))
    throw new HttpError(400, '第一行须为表头“问题”“预期答案”，请按模板填写。')
  const rows: { question: string; expected: string }[] = []
  for (const [n, cells] of [...table].sort((a, b) => a[0] - b[0])) {
    const question = cells[0]?.trim() ?? ''
    if (n === 1 || !question) continue
    if (question.length > MAX_QUESTION)
      throw new HttpError(400, `第 ${n} 行的问题超过 ${MAX_QUESTION} 字。`)
    rows.push({ question, expected: cells[1]?.trim() ?? '' })
  }
  if (!rows.length) throw new HttpError(400, '文件中没有问题。')
  if (rows.length > MAX_ROWS)
    throw new HttpError(400, `一次最多 ${MAX_ROWS} 条问题，文件中有 ${rows.length} 条。`)
  return rows
}

/**
 * 回答的纯文本，供与预期答案比对：去掉 Markdown 标记、链接地址和原文引用编号，保留链接文字；
 * 有序列表保留序号，表格每行一行、单元格以制表符分隔。
 */
export function plainText(markdown: string) {
  let items: ReturnType<typeof flatten>['items']
  try {
    items = flatten(markdown, 'VALSET_PLAIN_TEXT').items
  } catch {
    // 正文过于复杂、无法安全解析时只去掉链接地址
    return markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
  }
  const line = (segs: { text: string; sup?: boolean }[]) =>
    segs
      .flatMap((seg) => (seg.sup ? [] : [seg.text]))
      .join('')
      .trim()
  return items
    .map((item) => {
      if (item.type === 'table')
        return item.rows
          .map((row) => row.map((cell) => cell.map(line).join(' ')).join('\t'))
          .join('\n')
      const text = line(item.segs)
      return text && item.type === 'line' && item.mark?.ordered ? `${item.mark.n}. ${text}` : text
    })
    .filter((text) => text.trim())
    .join('\n')
}

/** 界面复制的同一段：最后一步的正文 */
const finalText = (message: AssistantMessage) =>
  splitAnswer(message)
    .final.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n')

/** XML 1.0 不能表示的字符去掉；ExcelJS 写入时不转义 _xHHHH_；单元格最多 32767 字 */
const cellText = (text: string) =>
  text
    .slice(0, 32767)
    .toWellFormed()
    .replace(/(?![\t\n\r])\p{Cc}|[\ufffe\uffff]/gu, '')
    .replace(/_(?=x[0-9a-fA-F]{4}_)/g, '_x005F_')

/**
 * 样式逐项同组委会模板 4、5：表头微软雅黑 11 号白色粗体、深蓝底、居中，行高 26；正文微软雅黑 10.5 号、
 * 垂直居中、自动换行，前三列左对齐、耗时与状态居中；全部单元格浅灰细边框，冻结首行，数字为常规格式。
 */
async function workbook(columns: [string, number][], rows: (string | number | undefined)[][]) {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Sheet1', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = columns.map(([header, width]) => ({ header, width }))
  sheet.addRows(
    rows.map((row) => row.map((cell) => (typeof cell === 'string' ? cellText(cell) : cell))),
  )
  const thin = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } }
  sheet.eachRow((row, n) => {
    for (let column = 1; column <= columns.length; column++) {
      const cell = row.getCell(column)
      cell.border = { top: thin, left: thin, bottom: thin, right: thin }
      cell.alignment = {
        horizontal: n === 1 || column > 3 ? 'center' : 'left',
        vertical: 'middle',
        wrapText: true,
      }
      cell.font =
        n === 1
          ? { name: '微软雅黑', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }
          : { name: '微软雅黑', size: 10.5, color: { argb: 'FF000000' } }
      if (n === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF305496' } }
    }
  })
  sheet.getRow(1).height = 26
  return Buffer.from(await book.xlsx.writeBuffer())
}

type Row = ValsetRow & { expected: string; answer?: string }
type Job = Omit<ValsetJob, 'model' | 'rows' | 'total' | 'finished'> & {
  userId: string
  selection: ModelSelection
  rows: Row[]
}

/** 导出列同组委会模板 5；没有回答时写“（空）”，耗时已取到一位小数 */
export const exportValset = (rows: Row[]) =>
  workbook(
    [
      ['问题', 36],
      ['预期答案', 50],
      ['智能体实际回复', 40],
      ['耗时(秒)', 10],
      ['状态', 10],
    ],
    rows.map((row) => [
      row.question,
      row.expected,
      row.status === '正常' && row.answer ? row.answer : '（空）',
      row.seconds,
      row.status,
    ]),
  )

const summary = (job: Job): ValsetJobSummary => ({
  id: job.id,
  name: job.name,
  createdAt: job.createdAt,
  state: job.state,
  total: job.rows.length,
  finished: job.rows.filter((row) => row.status).length,
})
const view = (job: Job): ValsetJob => ({
  ...summary(job),
  model: `${job.selection.provider}/${job.selection.model}`,
  rows: job.rows.map(({ question, status, running, seconds, sessionId, error }) => ({
    question,
    status,
    running,
    seconds,
    sessionId,
    error,
  })),
})

const API_IDENTITY: Identity = { subject: 'valset:api', name: '验证集接口' }
const digest = (text: string) => createHash('sha256').update(text).digest()
/** 组委会脚本可用 VALSET_API_TOKEN 调用验证集接口，无需浏览器登录；未配置时关闭。 */
export function valsetIdentity(request: IncomingMessage, path: string) {
  const token = process.env.VALSET_API_TOKEN?.trim()
  const given = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1]
  if (!token || !given || !path.startsWith('/api/valset/')) return undefined
  return timingSafeEqual(digest(given), digest(token)) ? API_IDENTITY : undefined
}

async function read(request: IncomingMessage, limit: number, tooLarge: string) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, tooLarge)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const setting = (name: string, fallback: number) => {
  const value = Number(process.env[name]?.trim() || fallback)
  if (!(value > 0)) throw new Error(`${name} 须为正数。`)
  return value
}

/**
 * 验证集测试：每题在独立的新会话中经同一 Agent 运行时作答，全进程最多同时执行 concurrency 题。
 * 任务与结果（输入输出日志）按任务保存在 DATA_DIR/valset，重启后未完成的题重新执行。
 * ponytail: 单进程内存排队、每题完成即整份重写任务文件；多进程部署或任务很大时改为数据库记录。
 */
export class Valset {
  jobs = new Map<string, Job>()
  aborts = new Map<string, AbortController>()
  busy = 0
  dir: string
  store: Store
  agents: Agents
  options: { concurrency: number; timeoutMs: number }
  constructor(
    store: Store,
    agents: Agents,
    options = {
      concurrency: setting('VALSET_CONCURRENCY', 3),
      timeoutMs: setting('VALSET_TIMEOUT_SECONDS', 180) * 1000,
    },
  ) {
    this.store = store
    this.agents = agents
    this.options = options
    this.dir = join(store.root, 'valset')
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const jobs: Job[] = []
    for (const name of readdirSync(this.dir).filter((name) => name.endsWith('.json')))
      try {
        jobs.push(JSON.parse(readFileSync(join(this.dir, name), 'utf8')))
      } catch {
        console.warn(`验证集任务文件 ${name} 无法读取，已跳过。`)
      }
    for (const job of jobs.sort((a, b) => a.createdAt - b.createdAt)) {
      // 重启前执行到一半的题：任务仍在执行时重新执行，已取消的任务记为已取消
      for (const row of job.rows) {
        delete row.running
        if (!row.status && job.state !== 'running') row.status = '已取消'
      }
      this.jobs.set(job.id, job)
    }
    this.pump()
  }
  /** 显式选模型：新会话的数据库默认是 DeepSeek 官方，部署可能只配了校内模型。取第一个已配置密钥的供应商。 */
  selection(): ModelSelection {
    const catalog = modelCatalog(!!this.agents.options.adapter)
    const provider = catalog.providers.find((item) => item.configured)
    return provider
      ? { provider: provider.id, model: provider.models[0].id }
      : catalog.defaultSelection
  }
  save(job: Job) {
    const file = join(this.dir, `${job.id}.json`)
    try {
      writeFileSync(file + '.tmp', JSON.stringify(job), { mode: 0o600 })
      renameSync(file + '.tmp', file)
    } catch (error) {
      console.error(`验证集任务 ${job.id} 保存失败：`, error)
    }
  }
  job(userId: string, id: string) {
    const job = this.jobs.get(id)
    if (job?.userId !== userId) throw new HttpError(404, '没有找到验证集任务。')
    return job
  }
  list(userId: string) {
    return [...this.jobs.values()]
      .filter((job) => job.userId === userId)
      .reverse()
      .slice(0, 50)
      .map(summary)
  }
  async create(userId: string, name: string, data: ArrayBuffer) {
    const job: Job = {
      id: randomUUID(),
      userId,
      name: name.slice(0, 255),
      createdAt: Date.now(),
      state: 'running',
      selection: this.selection(),
      rows: await parseValset(data),
    }
    this.jobs.set(job.id, job)
    this.save(job)
    this.pump()
    return view(job)
  }
  cancel(job: Job) {
    if (job.state === 'running') {
      job.state = 'cancelled'
      for (const row of job.rows) if (!row.status && !row.running) row.status = '已取消'
      this.aborts.get(job.id)?.abort()
      this.save(job)
    }
    return view(job)
  }
  pump() {
    for (const job of this.jobs.values())
      for (const row of job.state === 'running' ? job.rows : [])
        if (
          this.busy < this.options.concurrency &&
          !this.agents.closing &&
          !row.status &&
          !row.running
        )
          void this.run(job, row)
  }
  async run(job: Job, row: Row) {
    this.busy++
    row.running = true
    const abort = this.aborts.get(job.id) ?? new AbortController()
    this.aborts.set(job.id, abort)
    try {
      const result = await this.answer(
        job.userId,
        row.question,
        job.selection,
        abort.signal,
        (id) => {
          row.sessionId = id
        },
      )
      // 关闭服务而中断的题不记结果，重启后重新执行
      if (!this.agents.closing) Object.assign(row, result)
    } finally {
      this.busy--
      delete row.running
      if (!this.agents.closing) {
        if (job.state === 'running' && job.rows.every((item) => item.status)) job.state = 'done'
        this.save(job)
        this.pump()
      }
    }
  }
  /** 在新会话中回答一题，直到完成、失败、超时或被取消；超时与取消会停止该会话。 */
  async answer(
    userId: string,
    question: string,
    selection: ModelSelection,
    signal?: AbortSignal,
    onSession?: (id: string) => void,
  ) {
    const started = performance.now()
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const halt = signal ? AbortSignal.any([signal, timeout]) : timeout
    const halted = new Promise<false>((resolve) => {
      if (halt.aborted) resolve(false)
      halt.addEventListener('abort', () => resolve(false), { once: true })
    })
    let sessionId: string | undefined
    const end = (status: ValsetStatus, detail: { answer?: string; error?: string } = {}) => ({
      status,
      seconds: Math.round((performance.now() - started) / 100) / 10,
      sessionId,
      ...detail,
    })
    try {
      const title = `验证集 · ${question.replace(/[\s\p{Cc}]+/gu, ' ')}`.slice(0, 80)
      sessionId = this.store.create(userId, title, true).id
      onSession?.(sessionId)
      let finished = false
      if (!halt.aborted) {
        await this.agents.start(userId, sessionId, question, selection)
        const done = this.agents.active.get(sessionId)?.done
        finished =
          !done ||
          (await Promise.race([
            done.then(
              () => true,
              () => true,
            ),
            halted,
          ]))
        if (!finished) await this.agents.stop(userId, sessionId)
      }
      if (!finished) return end(timeout.aborted ? '超时' : '已取消')
      const message = (await this.agents.snapshot(userId, sessionId)).messages.findLast(
        (item) => item.role === 'assistant',
      )
      if (message?.status !== 'done')
        return end('失败', { error: message?.error ?? '回答未完成。' })
      const answer = plainText(finalText(message))
      return answer ? end('正常', { answer }) : end('失败', { error: '未返回正文。' })
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('验证集作答失败：', error)
      return end('失败', { error: error instanceof HttpError ? error.message : '执行失败。' })
    }
  }
  async ask(userId: string, question: string) {
    const result = await this.answer(userId, question, this.selection())
    try {
      appendFileSync(
        join(this.dir, 'ask.jsonl'),
        JSON.stringify({ time: new Date().toISOString(), userId, question, ...result }) + '\n',
        { mode: 0o600 },
      )
    } catch (error) {
      console.error('验证集接口日志写入失败：', error)
    }
    return result
  }
  async handle(request: IncomingMessage, response: ServerResponse, userId: string, path: string) {
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(value))
    }
    const xlsx = (name: string, data: Buffer) => {
      // RFC 8187 filename* excludes these characters left unescaped by encodeURIComponent.
      const filename = encodeURIComponent(name).replace(
        /['()*]/g,
        (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
      )
      response.writeHead(200, {
        'Content-Type': MIME.xlsx,
        'Content-Disposition': `attachment; filename="valset.xlsx"; filename*=UTF-8''${filename}`,
        'Content-Length': data.length,
      })
      response.end(data)
    }
    const method = request.method
    if (path === '/api/valset/template' && method === 'GET')
      return xlsx(
        '验证集上传模板.xlsx',
        await workbook(
          [
            ['问题', 42],
            ['预期答案', 60],
          ],
          [],
        ),
      )
    if (path === '/api/valset/ask' && method === 'POST') {
      if (!request.headers['content-type']?.startsWith('application/json'))
        throw new HttpError(415, '请求必须为 JSON。')
      const body = await read(request, 64 * 1024, '问题过长。')
      let input: { question?: unknown } | null
      try {
        input = JSON.parse(body.toString())
      } catch {
        throw new HttpError(400, 'JSON 格式错误。')
      }
      const question = typeof input?.question === 'string' ? input.question.trim() : ''
      if (!question || question.length > MAX_QUESTION)
        throw new HttpError(400, `问题须为 1–${MAX_QUESTION} 个字符。`)
      const { answer = '', seconds, status, error, sessionId } = await this.ask(userId, question)
      return json(200, { answer, seconds, status, error, sessionId })
    }
    if (path === '/api/valset/jobs') {
      if (method === 'GET') return json(200, this.list(userId))
      if (method === 'POST') {
        const type = request.headers['content-type'] ?? ''
        if (!type.startsWith('multipart/form-data'))
          throw new HttpError(415, '请以 multipart/form-data 上传，文件字段名为 file。')
        const body = await read(request, MAX_FILE + 65536, '文件不能超过 10 MB。')
        let file: FormDataEntryValue | null
        try {
          file = (
            await new Request('http://localhost/', {
              method: 'POST',
              headers: { 'Content-Type': type },
              body,
            }).formData()
          ).get('file')
        } catch {
          throw new HttpError(400, '上传内容格式错误。')
        }
        if (!(file instanceof File)) throw new HttpError(400, '缺少文件字段 file。')
        if (file.size > MAX_FILE) throw new HttpError(413, '文件不能超过 10 MB。')
        const data = await file.arrayBuffer()
        return json(201, await this.create(userId, file.name || '验证集.xlsx', data))
      }
    }
    const match = /^\/api\/valset\/jobs\/([0-9a-f-]{36})(?:\/(export|cancel))?$/.exec(path)
    if (!match) throw new HttpError(404, '接口不存在。')
    const job = this.job(userId, match[1])
    if (!match[2] && method === 'GET') return json(200, view(job))
    if (match[2] === 'cancel' && method === 'POST') return json(200, this.cancel(job))
    if (match[2] === 'export' && method === 'GET') {
      if (job.state === 'running' || job.rows.some((row) => row.running))
        throw new HttpError(409, '任务仍在执行，完成或取消后再导出。')
      return xlsx(
        `验证集结果-${job.name.replace(/\.xlsx$/i, '')}.xlsx`,
        await exportValset(job.rows),
      )
    }
    throw new HttpError(405, '不支持该操作。')
  }
}
