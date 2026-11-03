import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { TestModel } from '../tests/support/model.ts'
import type { ValsetJob } from '../src/types/valset.ts'
import { Agents } from './agent.ts'
import { createApp } from './http.ts'
import { Store } from './store.ts'
import { exportValset, parseValset, plainText, Valset } from './valset.ts'

async function xlsx(rows: unknown[][]) {
  const book = new ExcelJS.Workbook()
  book.addWorksheet('Sheet1').addRows(rows)
  return (await book.xlsx.writeBuffer()) as ArrayBuffer
}
async function readSheet(data: ArrayBuffer | Uint8Array) {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(new Uint8Array(data).buffer)
  const sheet = book.worksheets[0]
  return {
    sheet,
    values: sheet
      .getSheetValues()
      .slice(1)
      .map((row) => (row as unknown[]).slice(1)),
  }
}
const rejects = (data: ArrayBuffer, message: RegExp) =>
  assert.rejects(parseValset(data), (error: Error & { status?: number }) => {
    assert.equal(error.status, 400)
    assert.match(error.message, message)
    return true
  })

test('parses the two-column upload: header variants, blank rows and extra columns', async () => {
  const rows = await parseValset(
    await xlsx([
      [' 问题 ', '预期答案（参考答案）', '备注'],
      ['  第一问  ', ' 答一 ', '忽略'],
      [],
      ['', '没有问题的行跳过'],
      [2026, null],
    ]),
  )
  assert.deepEqual(rows, [
    { question: '第一问', expected: '答一' },
    { question: '2026', expected: '' },
  ])
  assert.equal((await parseValset(await xlsx([['问题', '参考答案'], ['问']])))[0].question, '问')
  await rejects(
    await xlsx([
      ['问', '答'],
      ['问题一', '答案一'],
    ]),
    /表头/,
  )
  await rejects(await xlsx([['问题', '预期答案']]), /没有问题/)
  await rejects(
    await xlsx([['问题', '预期答案'], ...Array.from({ length: 1001 }, (_, i) => [`问${i}`, ''])]),
    /最多 1000 条/,
  )
  await rejects(new TextEncoder().encode('问题,预期答案\n').buffer as ArrayBuffer, /\.xlsx/)
})

test('plain text drops Markdown syntax, link targets and citation numbers', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  assert.equal(
    plainText(
      [
        '## 结论',
        '',
        `按规划，**到 2025 年**建成[示范区](/api/library/passages/${id})，见[官网](https://example.org/a)。`,
        '',
        '1. 第一条',
        '2. 第二条',
        '',
        '- 要点',
        '',
        '> 引文',
        '',
        '| 指标 | 目标 |',
        '| --- | --- |',
        '| 覆盖率 | 90% |',
      ].join('\n'),
    ),
    [
      '结论',
      '按规划，到 2025 年建成示范区，见官网。',
      '1. 第一条',
      '2. 第二条',
      '要点',
      '引文',
      '指标\t目标',
      '覆盖率\t90%',
    ].join('\n'),
  )
})

test('export matches template 5: columns, styles, numeric seconds and （空） without a reply', async () => {
  const data = await exportValset([
    { question: '问一', expected: '答一', answer: '回复一', status: '正常', seconds: 12.3 },
    { question: '问二', expected: '答二', status: '超时', seconds: 180 },
    { question: '问三', expected: '答三', status: '失败', seconds: 0.4, error: '模型失败' },
  ])
  const { sheet, values } = await readSheet(data)
  assert.deepEqual(values, [
    ['问题', '预期答案', '智能体实际回复', '耗时(秒)', '状态'],
    ['问一', '答一', '回复一', 12.3, '正常'],
    ['问二', '答二', '（空）', 180, '超时'],
    ['问三', '答三', '（空）', 0.4, '失败'],
  ])
  // 样式逐项对照组委会模板 5
  const head = sheet.getCell('C1')
  assert.deepEqual(head.font, {
    name: '微软雅黑',
    size: 11,
    bold: true,
    color: { argb: 'FFFFFFFF' },
  })
  assert.equal((head.fill as { fgColor: { argb: string } }).fgColor.argb, 'FF305496')
  assert.equal(sheet.getRow(1).height, 26)
  assert.equal(sheet.getCell('A2').font.name, '微软雅黑')
  // ExcelJS 读回时把字号取整，直接看样式表：正文 10.5 号
  const styles = await (await JSZip.loadAsync(data)).file('xl/styles.xml')!.async('string')
  assert.match(styles, /<sz val="10.5"\/>/)
  assert.equal(sheet.getCell('A2').alignment.horizontal, 'left')
  assert.equal(sheet.getCell('D2').alignment.horizontal, 'center')
  assert.equal(sheet.getCell('E4').alignment.vertical, 'middle')
  assert.equal(sheet.getCell('E4').border.bottom?.style, 'thin')
  assert.equal(sheet.getCell('D2').numFmt, undefined, 'General like the template')
  assert.deepEqual(
    sheet.columns.map((column) => column.width),
    [36, 50, 40, 10, 10],
  )
  assert.equal((sheet.views[0] as { ySplit?: number }).ySplit, 1, 'header row frozen')
})

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'gczy-valset-'))
  const store = new Store(root)
  const agents = await new Agents(store, { adapter: new TestModel() }).init()
  t.after(async () => {
    await agents.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return { store, agents, user: store.user('valset-test', 'Test') }
}

test('questions use the first configured provider, not the sessions table default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-valset-model-'))
  const store = new Store(root)
  const saved = ['MODEL_PROVIDERS', 'DEEPSEEK_API_KEY', 'CAMPUS_API_KEY'].map((key) => [
    key,
    process.env[key],
  ])
  t.after(async () => {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key!]
      else process.env[key!] = value
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  process.env.MODEL_PROVIDERS = 'deepseek-official,campus'
  delete process.env.DEEPSEEK_API_KEY
  process.env.CAMPUS_API_KEY = 'test-campus-key'
  const valset = new Valset(store, { options: {} } as Agents, { concurrency: 1, timeoutMs: 1000 })
  assert.deepEqual(valset.selection(), { provider: 'campus', model: 'qwen3.8-27b' })
})

test('a question past the time limit is stopped and reported as 超时 with no reply', async (t) => {
  const { store, agents, user } = await fixture(t)
  const valset = new Valset(store, agents, { concurrency: 1, timeoutMs: 300 })
  const campus = { provider: 'campus', model: 'qwen3.8-27b' }
  const result = await valset.answer(user.id, '持续生成', campus)
  assert.equal(result.status, '超时')
  assert.equal(result.answer, undefined)
  assert.ok(result.seconds >= 0.3 && result.seconds < 5)
  assert.equal(agents.active.size, 0, 'the timed-out run is stopped')
  const session = await agents.snapshot(user.id, result.sessionId!)
  // 会话按传入的模型作答，不落到会话表的默认值（DeepSeek 官方）
  assert.deepEqual({ provider: session.provider, model: session.model }, campus)
  const last = session.messages.at(-1)
  assert.ok(last?.role === 'assistant' && last.status === 'stopped')
  assert.deepEqual(store.list(user.id), [], 'validation sessions stay out of the research list')
})

test('jobs run over HTTP, survive a restart, cancel, and the bearer token only opens valset', async (t) => {
  const { store, agents } = await fixture(t)
  const server = createApp(store, agents, {
    origin: 'http://127.0.0.1',
    authenticate: async (request) =>
      request.headers.cookie === 'user=a' ? { subject: 'valset-a', name: 'A' } : undefined,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${address.port}/api/valset${path}`, {
      ...init,
      headers: { cookie: 'user=a', ...init.headers },
    })
  const upload = async (rows: unknown[][]) => {
    const form = new FormData()
    form.append('file', new Blob([await xlsx(rows)]), '样例.xlsx')
    return api('/jobs', { method: 'POST', body: form })
  }
  const wait = async (id: string) => {
    for (;;) {
      const job = (await (await api(`/jobs/${id}`)).json()) as ValsetJob
      if (job.state !== 'running') return job
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  const wrong = await upload([
    ['题目', '答案'],
    ['问', '答'],
  ])
  assert.equal(wrong.status, 400)
  assert.match((await wrong.json()).error, /表头/)

  const created = await upload([
    ['问题', '预期答案'],
    ['你好', '测试回答'],
    ['模拟失败', '无'],
  ])
  assert.equal(created.status, 201)
  const { id } = (await created.json()) as ValsetJob
  const done = await wait(id)
  assert.equal(done.state, 'done')
  assert.deepEqual(
    done.rows.map((row) => row.status),
    ['正常', '失败'],
  )
  assert.ok(done.rows.every((row) => row.sessionId && typeof row.seconds === 'number'))
  assert.ok(done.rows[1].error)

  const exported = await api(`/jobs/${id}/export`)
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get('content-disposition')!, /filename\*=UTF-8''.*\.xlsx/)
  const { values } = await readSheet(await exported.arrayBuffer())
  assert.deepEqual(values[0], ['问题', '预期答案', '智能体实际回复', '耗时(秒)', '状态'])
  const reply = String(values[1][2])
  assert.match(reply, /^测试回答\n这是自动化测试结果。\n第一项\n第二项\n来源/)
  assert.doesNotMatch(reply, /\*\*|##|\]\(|https?:/)
  assert.equal(values[2][2], '（空）')

  // 重启后从数据目录读回同一结果
  const restarted = new Valset(store, agents)
  assert.deepEqual(
    restarted.list(store.user('valset-a', 'A').id).map((job) => job.state),
    ['done'],
  )

  // 取消：执行中的题停止，未开始的题记为已取消
  const hanging = (await (
    await upload([['问题', '预期答案'], ...Array.from({ length: 5 }, () => ['持续生成', ''])])
  ).json()) as ValsetJob
  assert.equal((await api(`/jobs/${hanging.id}/export`)).status, 409)
  const cancelled = await api(`/jobs/${hanging.id}/cancel`, { method: 'POST' })
  assert.equal(cancelled.status, 200)
  const final = await (async () => {
    for (;;) {
      const job = (await (await api(`/jobs/${hanging.id}`)).json()) as ValsetJob
      if (job.rows.every((row) => !row.running)) return job
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })()
  assert.equal(final.state, 'cancelled')
  assert.ok(final.rows.every((row) => row.status === '已取消'))
  assert.equal(agents.active.size, 0)

  const bearer = (token: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const token = 'test-token-0123456789'
  assert.equal((await bearer(token, '/valset/jobs')).status, 401, 'off without VALSET_API_TOKEN')
  process.env.VALSET_API_TOKEN = token
  t.after(() => {
    delete process.env.VALSET_API_TOKEN
  })
  assert.equal((await bearer('wrong-token', '/valset/jobs')).status, 401)
  assert.equal((await bearer(token, '/sessions')).status, 401)
  assert.deepEqual(await (await bearer(token, '/valset/jobs')).json(), [])
  const answered = await bearer(token, '/valset/ask', { question: '你好' })
  assert.equal(answered.status, 200)
  const body = await answered.json()
  assert.equal(body.status, '正常')
  assert.match(body.answer, /^测试回答\n/)
  assert.equal(typeof body.seconds, 'number')
})
