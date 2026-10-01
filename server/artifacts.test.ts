import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { Artifacts } from './artifacts.ts'
import { Store } from './store.ts'
import { toolError } from './view.ts'

test('generated Word reads preserve paragraph text and whitespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-docx-text-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const paragraphs = [
      '# 标题',
      '  缩进与尾空格  ',
      '\t制表符\t',
      '　全角缩进　',
      '\u00a0不换行空格\u00a0',
      '   ',
      '',
      '00123 & <原文> 😀',
      '## 二级标题',
      '### 三级标题',
      '#### 保留普通段落',
    ]
    const artifact = await files.create(
      user.id,
      session.id,
      '正文保真',
      'docx',
      paragraphs.join('\r\n'),
    )
    assert.equal(
      await files.read(user.id, session.id, artifact.id),
      paragraphs.map((line) => line.replace(/^#{1,3} /, '')).join('\n') + '\n',
    )
    const zip = await JSZip.loadAsync(await readFile(files.path(artifact.id)))
    const xml = await zip.file('word/document.xml')!.async('string')
    for (const heading of ['Heading1', 'Heading2', 'Heading3']) assert.ok(xml.includes(heading))
    assert.ok(xml.includes('xml:space="preserve"'))
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('generated spreadsheets preserve literal OOXML escapes in files and read_file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-xlsx-text-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const rows = [
      ['指标', '数量'],
      ['政策_x0041_编号', 3],
      ['_x000A_', 0],
      ['_x005F_x0041_', -2.5],
      ['_x005f_x0041_', 1],
      ['_x0041__x0042_', 2],
      ['_x0041_x0042_', 9],
      ['_x00eA_', 4],
      ['_X0041_ x005F_ _x123_ _xZZZZ_', 5],
      ['空白\t文本\n<&> 😀', 6],
      ['=1+1', 7],
      ['', 8],
    ]
    const artifact = await files.create(
      user.id,
      session.id,
      '指标对比',
      'xlsx',
      JSON.stringify(rows),
    )
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(Uint8Array.from(await readFile(files.path(artifact.id))).buffer)
    const sheet = book.worksheets[0]
    assert.deepEqual(
      rows.map((row, i) => row.map((_, j) => sheet.getCell(i + 1, j + 1).value)),
      rows,
    )
    const read: unknown[][] = JSON.parse(await files.read(user.id, session.id, artifact.id))
    assert.deepEqual(
      read.slice(1).map((row) => row.slice(1)),
      rows,
    )
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('Word rejects characters that cannot form valid XML before publishing an artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-docx-invalid-text-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    for (const char of ['\0', '\v', '\f', '\u001f', '\ufffe', '\uffff', '\ud800', '\udfff']) {
      await assert.rejects(
        files.create(user.id, session.id, '报告', 'docx', `前文${char}后文`),
        { code: 'FILE_INVALID_DOCX_CONTENT' },
        `code unit ${char.charCodeAt(0).toString(16)}`,
      )
    }
    assert.equal(store.artifacts(user.id, session.id).length, 0)
    assert.match(toolError('FILE_INVALID_DOCX_CONTENT'), /Word.*字符/)
    const valid = '制表符\t与换行\n中文、😀、\ufffd、\u{1ffff}'
    const artifact = await files.create(user.id, session.id, '有效正文', 'docx', valid)
    assert.equal(await files.read(user.id, session.id, artifact.id), valid + '\n')
    assert.deepEqual(await readdir(join(root, 'artifacts')), [artifact.id])
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('Excel rejects characters that cannot form valid XML; CSV keeps them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-xlsx-invalid-text-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    for (const char of ['\0', '\v', '\ufffe', '\uffff', '\ud800']) {
      await assert.rejects(
        files.create(
          user.id,
          session.id,
          '表格',
          'xlsx',
          JSON.stringify([['指标'], [`前${char}后`]]),
        ),
        { code: 'FILE_INVALID_XLSX_CONTENT' },
        `code unit ${char.charCodeAt(0).toString(16)}`,
      )
    }
    assert.equal(store.artifacts(user.id, session.id).length, 0)
    assert.match(toolError('FILE_INVALID_XLSX_CONTENT'), /Excel.*字符/)
    const csv = await files.create(user.id, session.id, '表格', 'csv', '[["前\uffff后"]]')
    assert.match(await files.read(user.id, session.id, csv.id), /前\uffff后/)
    assert.deepEqual(await readdir(join(root, 'artifacts')), [csv.id])
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})
