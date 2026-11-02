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
    // 正文按 Markdown 解析：每行仍是一段，行首行尾的半角空格与制表符属于 Markdown 语法，不保留
    const paragraphs = [
      '# 标题',
      '　全角缩进　',
      '\u00a0不换行空格\u00a0',
      '内部\t制表符',
      '',
      '00123 & <原文> 😀',
      '# 一级标题',
      '## 二级标题',
      '### 三级标题',
      '#### 四级标题',
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
      paragraphs
        .filter(Boolean)
        .map((line) => line.replace(/^#+ /, ''))
        .join('\n') + '\n',
    )
    const zip = await JSZip.loadAsync(await readFile(files.path(artifact.id)))
    const xml = await zip.file('word/document.xml')!.async('string')
    for (const style of ['Title', 'Heading1', 'Heading2', 'Heading3', 'Heading4'])
      assert.ok(xml.includes(`<w:pStyle w:val="${style}"/>`), style)
    assert.ok(xml.includes('xml:space="preserve"'))
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('Word renders Markdown tables, lists, emphasis, links and quotes as Word structures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-docx-markdown-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const content = [
      '# 对比报告',
      '## 一、要点',
      '正文**加粗**与*强调*，见[planid 7·原文](/api/library/passages/00000000-0000-4000-8000-000000000000)与[统计局](https://www.stats.gov.cn/)。',
      '',
      '- 第一条',
      '  - 子条目',
      '',
      '1. 甲',
      '2. 乙',
      '',
      '| 地区 | 目标 |',
      '| --- | ---: |',
      '| 上海 | **4.5%**<br>左右 |',
      '| 江苏 |',
      '',
      '> 原文摘录',
      '',
      '1. 丙',
      '',
      '段落',
      '',
      '2. 丁',
    ].join('\n')
    const artifact = await files.create(user.id, session.id, '报告', 'docx', content)
    const zip = await JSZip.loadAsync(await readFile(files.path(artifact.id)))
    const xml = await zip.file('word/document.xml')!.async('string')
    const text = await files.read(user.id, session.id, artifact.id)
    // 表格每个单元格各占一段，缺的单元格补成空段；表后留一个空段
    assert.equal(
      text,
      '对比报告\n一、要点\n正文加粗与强调，见planid 7·原文与统计局。\n第一条\n子条目\n甲\n乙\n地区\n目标\n上海\n4.5%\n左右\n江苏\n\n\n原文摘录\n丙\n段落\n丁\n',
    )
    assert.doesNotMatch(text, /[|*]|\]\(|\/api\//)
    assert.equal(xml.match(/<w:tbl>/g)?.length, 1)
    assert.equal(xml.match(/<w:tr>/g)?.length, 3)
    assert.equal(xml.match(/<w:tc>/g)?.length, 6)
    assert.match(xml, /<w:tblHeader\/>/)
    assert.match(xml, /w:fill="E7E6E6"/)
    assert.match(xml, /<w:jc w:val="right"\/>(?:(?!<\/w:p>).)*4\.5%/)
    assert.match(xml, /<w:b\/>(?:(?!<\/w:r>).)*>加粗</)
    assert.match(xml, /<w:b\/>(?:(?!<\/w:r>).)*>地区</)
    assert.match(xml, /<w:i\/>(?:(?!<\/w:r>).)*>强调</)
    assert.match(xml, /<w:pStyle w:val="Quote"\/>(?:(?!<\/w:p>).)*原文摘录/)
    const levels = [...xml.matchAll(/<w:numPr><w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/>/g)]
    assert.deepEqual(
      levels.map((match) => match[1]),
      ['0', '1', '0', '0', '0', '0'],
    )
    // 无序与有序列表用不同的编号定义；同一有序列表共用一个编号实例，新列表从 1 重新编号，
    // 被段落隔开、从 2 起编的列表接着上一列表编号
    const ids = levels.map((match) => match[2])
    assert.notEqual(ids[0], ids[2])
    assert.equal(ids[2], ids[3])
    assert.notEqual(ids[4], ids[2])
    assert.equal(ids[5], ids[4])
    const numbering = await zip.file('word/numbering.xml')!.async('string')
    assert.match(numbering, /w:numFmt w:val="bullet"/)
    assert.match(numbering, /w:numFmt w:val="decimal"/)
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    assert.match(rels, /Target="https:\/\/www\.stats\.gov\.cn\/" TargetMode="External"/)
    assert.doesNotMatch(rels, /api\/library/)
    const footer = await zip.file(/^word\/footer\d*\.xml$/)[0].async('string')
    assert.match(footer, /PAGE/)
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

test('generated spreadsheets style the header, fit column widths and freeze the header row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-xlsx-style-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const rows = [
      ['地区', '研发投入强度目标', '说明'],
      ['上海', 4.5, '长'.repeat(40)],
      ['江苏', '3.2% 左右', '第一行\n第二行'],
    ]
    const artifact = await files.create(user.id, session.id, '对比', 'xlsx', JSON.stringify(rows))
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(Uint8Array.from(await readFile(files.path(artifact.id))).buffer)
    const sheet = book.worksheets[0]
    assert.deepEqual(
      (sheet.views as ExcelJS.WorksheetViewFrozen[]).map(({ state, ySplit }) => ({
        state,
        ySplit,
      })),
      [{ state: 'frozen', ySplit: 1 }],
    )
    // 最长一行的显示宽度（汉字计 2）加 2，至少 10、至多 50
    assert.deepEqual(
      [1, 2, 3].map((j) => sheet.getColumn(j).width),
      [10, 18, 50],
    )
    for (let j = 1; j <= 3; j++) {
      assert.equal(sheet.getCell(1, j).font.bold, true)
      assert.equal(sheet.getCell(1, j).fill.type, 'pattern')
      for (let i = 1; i <= 3; i++) {
        assert.equal(sheet.getCell(i, j).alignment.wrapText, true)
        assert.equal(sheet.getCell(i, j).border.bottom?.style, 'thin')
      }
    }
    assert.equal(sheet.getCell(2, 1).font?.bold, undefined)
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
    // 模型常把 Markdown 表格当作 xlsx 内容：须返回格式说明，而不是笼统的工具失败
    await assert.rejects(
      files.create(user.id, session.id, '表格', 'xlsx', '| 指标 |\n|---|\n| 1 |'),
      {
        code: 'FILE_INVALID_TABLE',
      },
    )
    const csv = await files.create(user.id, session.id, '表格', 'csv', '[["前\uffff后"]]')
    assert.match(await files.read(user.id, session.id, csv.id), /前\uffff后/)
    assert.deepEqual(await readdir(join(root, 'artifacts')), [csv.id])
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('generated decks have a cover, a slide per heading and continuation slides for long bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-pptx-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const items = Array.from({ length: 15 }, (_, i) => `第${i + 1}条` + '字'.repeat(30))
    const long = '长'.repeat(700)
    const content = [
      '# 长三角规划对比',
      '## 一、背景',
      '- 要点 & <原文>',
      '普通段落 😀',
      '## 二、主要做法',
      '### 1. 产业',
      ...items,
      '### 2. 长段',
      long,
    ].join('\n')
    await assert.rejects(files.create(user.id, session.id, '汇报', 'pptx', '前￿后'), {
      code: 'FILE_INVALID_PPTX_CONTENT',
    })
    assert.match(toolError('FILE_INVALID_PPTX_CONTENT'), /演示文稿.*字符/)
    const artifact = await files.create(user.id, session.id, '汇报.pptx', 'pptx', content)
    assert.equal(artifact.name, '汇报.pptx')
    const zip = await JSZip.loadAsync(await readFile(files.path(artifact.id)))
    assert.equal(zip.file(/^ppt\/slides\/slide\d+\.xml$/).length, 7)
    const slides = await Promise.all(
      Array.from({ length: 7 }, async (_, i) => {
        const xml = await zip.file(`ppt/slides/slide${i + 1}.xml`)!.async('string')
        return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1])
      }),
    )
    assert.deepEqual(slides.slice(0, 3), [
      ['长三角规划对比'],
      ['一、背景', '要点 &amp; &lt;原文&gt;', '普通段落 😀'],
      ['二、主要做法'],
    ])
    assert.deepEqual(slides[3], ['1. 产业', ...items.slice(0, 14)])
    assert.deepEqual(slides[4], ['1. 产业（续）', items[14]])
    assert.deepEqual(slides[5], ['2. 长段', long.slice(0, 616)])
    assert.deepEqual(slides[6], ['2. 长段（续）', long.slice(616)])
    assert.match(await zip.file('ppt/slides/slide2.xml')!.async('string'), /<a:buChar/)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('decks render bold runs, nested bullets and tables split across slides with the header repeated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-pptx-markdown-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const body = Array.from({ length: 30 }, (_, i) => `| 地区${i + 1} | 目标${i + 1} |`)
    const content = [
      '# 汇报',
      '## 要点',
      '- **加粗**说明',
      '  - 子要点',
      '1. 甲',
      '## 对比',
      '| 地区 | 目标 |',
      '| --- | --- |',
      ...body,
      '',
      '表后说明',
    ].join('\n')
    const artifact = await files.create(user.id, session.id, '汇报', 'pptx', content)
    const zip = await JSZip.loadAsync(await readFile(files.path(artifact.id)))
    const count = zip.file(/^ppt\/slides\/slide\d+\.xml$/).length
    const slides = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        zip.file(`ppt/slides/slide${i + 1}.xml`)!.async('string'),
      ),
    )
    const texts = (xml: string) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1])
    assert.deepEqual(texts(slides[1]), ['要点', '加粗', '说明', '子要点', '1. ', '甲'])
    assert.match(slides[1], /b="1"[^>]*>(?:(?!<\/a:r>).)*<a:t>加粗</)
    assert.match(slides[1], /<a:pPr lvl="1"[^>]*>(?:(?!<\/a:pPr>).)*<a:buChar/)
    // 表格单独成页，按估算行高切开，每页重复表头，标题标“（续）”；表后的文字另起一页
    const tables = slides.filter((xml) => xml.includes('<a:tbl>'))
    assert.equal(tables.length, 2)
    assert.deepEqual(
      tables.map((xml) => texts(xml).slice(0, 3)),
      [
        ['对比', '地区', '目标'],
        ['对比（续）', '地区', '目标'],
      ],
    )
    assert.deepEqual(
      tables.flatMap((xml) => texts(xml).slice(3)),
      body.flatMap((row) =>
        row
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim()),
      ),
    )
    assert.deepEqual(texts(slides.at(-1)!), ['对比（续）', '表后说明'])
    assert.equal(count, 5)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})
