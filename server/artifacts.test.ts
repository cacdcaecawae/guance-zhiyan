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

/** 幻灯片中的文字，不含页码 */
const texts = (xml: string) =>
  [...xml.replace(/<a:fld .*?<\/a:fld>/g, '').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1])

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
      '##### 五级标题',
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
    // 开头的 # 是文档标题，其后 ## 起依次为 1–4 级标题，多出的 # 按一级
    assert.deepEqual(
      [...xml.matchAll(/<w:pStyle w:val="(\w+)"\/>/g)].map((match) => match[1]),
      ['Title', 'Heading1', 'Heading1', 'Heading2', 'Heading3', 'Heading4'],
    )
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
    const a = '/api/library/passages/00000000-0000-4000-8000-00000000000A'
    const b = '/api/library/passages/00000000-0000-4000-8000-00000000000b'
    const content = [
      '# 对比报告',
      '## 一、要点',
      `正文**加粗**与*强调*，见[planid 7·原文](${a})与[统计局](https://www.stats.gov.cn/)。`,
      `**结论：**目标"十三五"，'快递进邮站'，it's "ok"，再见[planid 7·原文](${a})与[planid 8·原文](${b})。`,
      '',
      '---',
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
      '段<br><br>落  ',
      '',
      '2. 丁',
    ].join('\n')
    const artifact = await files.create(user.id, session.id, '报告', 'docx', content)
    const zip = await JSZip.loadAsync(await readFile(files.path(artifact.id)))
    const xml = await zip.file('word/document.xml')!.async('string')
    const text = await files.read(user.id, session.id, artifact.id)
    // 空行与分隔线不出段落；表格每个单元格各占一段，缺的单元格补成空段，表后留一个空段。
    // 文献引用按片段编号（同一片段同一编号），文末列出来源
    assert.equal(
      text,
      [
        '对比报告',
        '一、要点',
        '正文加粗与强调，见planid 7·原文[1]与统计局。',
        '结论：目标“十三五”，‘快递进邮站’，it\'s "ok"，再见planid 7·原文[1]与planid 8·原文[2]。',
        ...['第一条', '子条目', '甲', '乙', '地区', '目标', '上海', '4.5%', '左右', '江苏', '', ''],
        ...['原文摘录', '丙', '段', '落', '丁', '引用来源'],
        `[1]\tplanid 7·原文　片段 ${a.slice(-36).toLowerCase()}`,
        `[2]\tplanid 8·原文　片段 ${b.slice(-36)}`,
        '',
      ].join('\n'),
    )
    assert.doesNotMatch(text, /[|*]|\]\(|\/api\/|---/)
    assert.match(xml, /<w:b\/>(?:(?!<\/w:r>).)*>结论：</)
    assert.equal(
      xml.match(/<w:vertAlign w:val="superscript"\/>(?:(?!<\/w:r>).)*>\[\d\]</g)?.length,
      3,
    )
    // 篇幅短的文档不加封面：只有一节，页眉为标题，页脚为“第 X 页 / 共 Y 页”
    assert.equal(xml.match(/<w:sectPr/g)?.length, 1)
    const header = await zip.file(/^word\/header\d*\.xml$/)[0].async('string')
    assert.match(header, />对比报告</)
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
    assert.match(
      footer,
      />第 <(?:(?!SECTIONPAGES).)*PAGE(?:(?!SECTIONPAGES).)*> 页 \/ 共 <.*SECTIONPAGES.*> 页</,
    )
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('long Word reports get a cover with the title, subtitle and preamble, and number pages from the body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-docx-cover-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const title = '长'.repeat(40)
    const content = [
      `# ${title}`,
      '## ——副标题',
      '依据文献：某规划',
      '## 一',
      '甲',
      '## 二',
      '## 三',
      '### 小节',
    ].join('\n')
    const artifact = await files.create(user.id, session.id, '报告', 'docx', content)
    const zip = await JSZip.loadAsync(await readFile(files.path(artifact.id)))
    const xml = await zip.file('word/document.xml')!.async('string')
    // 封面一节没有页眉页脚，正文一节从第 1 页起编
    const [cover, body] = xml.split(/<w:sectPr/)
    const [coverSection, bodySection] = xml.match(/<w:sectPr.*?<\/w:sectPr>/g)!
    assert.equal(xml.match(/<w:sectPr/g)?.length, 2)
    assert.match(cover, /<w:pStyle w:val="Title"\/>(?:(?!<\/w:p>).)*长/)
    assert.match(cover, /<w:pStyle w:val="Subtitle"\/>(?:(?!<\/w:p>).)*>副标题</)
    assert.match(cover, /<w:shd [^>]*w:fill="F5F5F5"(?:(?!<\/w:tbl>).)*依据文献：某规划/)
    assert.doesNotMatch(coverSection, /<w:headerReference|<w:footerReference/)
    assert.match(bodySection, /<w:headerReference(?:(?!<\/w:sectPr>).)*<w:pgNumType w:start="1"\/>/)
    assert.doesNotMatch(body, /依据文献/)
    assert.match(body, /<w:pStyle w:val="Heading1"\/>(?:(?!<\/w:p>).)*>一</)
    assert.match(body, /<w:pStyle w:val="Heading2"\/>(?:(?!<\/w:p>).)*>小节</)
    // 页眉中过长的标题截断
    const header = await zip.file(/^word\/header\d*\.xml$/)[0].async('string')
    assert.match(header, new RegExp(`>${'长'.repeat(29)}…<`))
    // 三个一级章节以下不加封面
    const short = await files.create(
      user.id,
      session.id,
      '报告',
      'docx',
      content.replace('## 三', '### 三'),
    )
    const shortZip = await JSZip.loadAsync(await readFile(files.path(short.id)))
    const shortXml = await shortZip.file('word/document.xml')!.async('string')
    assert.equal(shortXml.match(/<w:sectPr/g)?.length, 1)
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
      ['地区', '目标', '说明', '编号'],
      ['上海', '4.5', '长'.repeat(40), '00123'],
      ['江苏', 3, '第一行\n"十三五"规划', '1234567890'],
    ]
    const artifact = await files.create(user.id, session.id, '对比', 'xlsx', JSON.stringify(rows))
    const data = await readFile(files.path(artifact.id))
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(Uint8Array.from(data).buffer)
    const sheet = book.worksheets[0]
    assert.equal(sheet.name, '对比')
    assert.deepEqual(
      (sheet.views as ExcelJS.WorksheetViewFrozen[]).map(({ state, ySplit }) => ({
        state,
        ySplit,
      })),
      [{ state: 'frozen', ySplit: 1 }],
    )
    // 列宽：表头显示宽度（汉字计 2）加 4、内容加 2 取大，至少 8、至多 50
    assert.deepEqual(
      [1, 2, 3, 4].map((j) => sheet.getColumn(j).width),
      [8, 8, 50, 12],
    )
    for (let j = 1; j <= 4; j++) {
      assert.equal(sheet.getCell(1, j).font.bold, true)
      assert.equal(sheet.getCell(1, j).fill.type, 'pattern')
      for (let i = 1; i <= 3; i++) {
        assert.equal(sheet.getCell(i, j).alignment.wrapText, true)
        assert.equal(sheet.getCell(i, j).border.bottom?.style, 'thin')
      }
    }
    assert.equal(sheet.getCell(2, 1).font?.bold, undefined)
    assert.equal(sheet.getCell(2, 1).alignment.horizontal, 'center')
    assert.equal(sheet.getCell(2, 3).alignment.horizontal, undefined)
    // 表头以下的纯数字文本存为数值；有前导零或超过 9 位的保留文本；中文引号换成弯引号
    assert.deepEqual(
      [2, 3].map((i) => [2, 3, 4].map((j) => sheet.getCell(i, j).value)),
      [
        [4.5, '长'.repeat(40), '00123'],
        [3, '第一行\n“十三五”规划', '1234567890'],
      ],
    )
    const zip = await JSZip.loadAsync(data)
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    assert.match(xml, /<autoFilter ref="A1:D1"\/>/)
    assert.match(xml, /<pageSetup[^>]*orientation="landscape"/)
    assert.match(xml, /<pageSetUpPr fitToPage="1"\/>/)
    assert.match(xml, /<pageSetup[^>]*fitToWidth="1"[^>]*fitToHeight="0"/)
    assert.match(
      xml,
      /<oddHeader>&amp;C对比<\/oddHeader><oddFooter>&amp;C第 &amp;P 页 \/ 共 &amp;N 页/,
    )
    const workbook = await zip.file('xl/workbook.xml')!.async('string')
    assert.match(workbook, /_xlnm\.Print_Titles[^>]*>&apos;对比&apos;!\$1:\$1</)
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
    // 既不是 JSON 数组也不是 Markdown 表格：须返回格式说明，而不是笼统的工具失败
    for (const content of ['指标：1', '["指标"]\n{"a":1}', '| 指标 |\n| 1 |'])
      await assert.rejects(files.create(user.id, session.id, '表格', 'xlsx', content), {
        code: 'FILE_INVALID_TABLE',
      })
    assert.match(toolError('FILE_INVALID_TABLE'), /JSON 数组或 Markdown 表格/)
    const csv = await files.create(user.id, session.id, '表格', 'csv', '[["前\uffff后"]]')
    assert.match(await files.read(user.id, session.id, csv.id), /前\uffff后/)
    assert.deepEqual(await readdir(join(root, 'artifacts')), [csv.id])
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('spreadsheets also accept a Markdown table or one JSON array per line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-table-input-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const markdown = [
      '说明文字',
      '',
      '| 指标 | 数值 |',
      '| --- | --- |',
      '| **快递** | 12 |',
      '| 见[planid 1·原文](/api/library/passages/00000000-0000-4000-8000-000000000000) | 3<br>4 |',
      '',
      '| 第二张 |',
      '| --- |',
      '| 忽略 |',
    ].join('\n')
    const xlsx = await files.create(user.id, session.id, '表格', 'xlsx', markdown)
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(Uint8Array.from(await readFile(files.path(xlsx.id))).buffer)
    const sheet = book.worksheets[0]
    assert.equal(sheet.rowCount, 3)
    assert.deepEqual(
      [1, 2, 3].map((i) => [1, 2].map((j) => sheet.getCell(i, j).value)),
      [
        ['指标', '数值'],
        ['快递', 12],
        ['见planid 1·原文', '3\n4'],
      ],
    )
    const csv = await files.create(
      user.id,
      session.id,
      '表格',
      'csv',
      '["序号","名称"]\n\n["1","甲"]\n',
    )
    assert.equal(await files.read(user.id, session.id, csv.id), '"序号","名称"\r\n"1","甲"')
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('quotes in file names become Chinese quotes so Windows downloads keep them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-file-name-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const artifact = await files.create(user.id, session.id, '淮安市"十三五"规划"', 'md', '正文')
    assert.equal(artifact.name, '淮安市“十三五”规划”.md')
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
    assert.equal(zip.file(/^ppt\/slides\/slide\d+\.xml$/).length, 6)
    const slides = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const xml = await zip.file(`ppt/slides/slide${i + 1}.xml`)!.async('string')
        return texts(xml)
      }),
    )
    // 没有正文、下面还有小节的“二、主要做法”不单独成页，显示在其下各页标题上方
    assert.deepEqual(slides.slice(0, 2), [
      ['长三角规划对比'],
      ['一、背景', '要点 &amp; &lt;原文&gt;', '普通段落 😀'],
    ])
    assert.deepEqual(slides[2], ['二、主要做法', '1. 产业', ...items.slice(0, 14)])
    assert.deepEqual(slides[3], ['二、主要做法', '1. 产业（续）', items[14]])
    assert.deepEqual(slides[4], ['二、主要做法', '2. 长段', long.slice(0, 616)])
    assert.deepEqual(slides[5], ['二、主要做法', '2. 长段（续）', long.slice(616)])
    assert.match(await zip.file('ppt/slides/slide2.xml')!.async('string'), /<a:buChar/)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('decks render bold runs, nested bullets, numbered items, notes, citations and tables split across slides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-pptx-markdown-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const body = Array.from({ length: 26 }, (_, i) => `| 地区${i + 1} | 目标${i + 1} |`)
    const passage = '00000000-0000-4000-8000-000000000000'
    const cite = `[planid 1·原文](/api/library/passages/${passage})`
    const content = [
      '# 汇报',
      '## ——副标题',
      '依据文献：某规划',
      '## 一、要点',
      `- **加粗**说明${cite}`,
      '  - 子要点',
      '1. 甲',
      '2. 乙',
      `> 出处：${cite}`,
      '## 二、比较',
      '> 本节为推断',
      '### 对比',
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
    // 破折号标题作封面副标题，其下的简短说明也放在封面
    assert.deepEqual(texts(slides[0]), ['汇报', '副标题', '依据文献：某规划'])
    assert.doesNotMatch(slides[0], /type="slidenum"/)
    assert.deepEqual(texts(slides[1]), [
      ...['一、要点', '加粗', '说明', 'planid 1·原文', '[1]', '子要点', '甲', '乙'],
      ...['出处：', 'planid 1·原文', '[1]'],
    ])
    assert.match(slides[1], /type="slidenum"><a:rPr[^>]*\/><a:t>2</)
    assert.match(slides[1], /b="1"[^>]*>(?:(?!<\/a:r>).)*<a:t>加粗</)
    assert.match(slides[1], /baseline="30000"[^>]*>(?:(?!<\/a:r>).)*<a:t>\[1\]</)
    assert.match(slides[1], /<a:pPr lvl="1"[^>]*>(?:(?!<\/a:pPr>).)*<a:buChar/)
    for (const [n, text] of [
      [1, '甲'],
      [2, '乙'],
    ])
      assert.match(
        slides[1],
        new RegExp(
          `<a:buAutoNum type="arabicPeriod" startAt="${n}"\\/><\\/a:pPr><a:r>(?:(?!<\\/a:r>).)*<a:t>${text}<`,
        ),
      )
    // 引用作页底注
    assert.match(slides[1], /sz="1100"[^>]*>(?:(?!<\/a:r>).)*<a:t>出处：</)
    // 只有引用注的“二、比较”不单独成页：作章节名显示在其下各页标题上方，引用注并入下一页
    // 表格单独成页，按估算行高切开，每页重复表头，标题标“（续）”；表后的文字另起一页
    const tables = slides.filter((xml) => xml.includes('<a:tbl>'))
    assert.equal(tables.length, 2)
    assert.deepEqual(
      tables.map((xml) => texts(xml).slice(0, 4)),
      [
        ['二、比较', '对比', '地区', '目标'],
        ['二、比较', '对比（续）', '地区', '目标'],
      ],
    )
    assert.equal(texts(tables[0]).at(-1), '本节为推断')
    assert.deepEqual(
      tables.flatMap((xml) => texts(xml).slice(4)).filter((text) => text !== '本节为推断'),
      body.flatMap((row) =>
        row
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim()),
      ),
    )
    assert.deepEqual(texts(slides.at(-2)!), ['二、比较', '对比（续）', '表后说明'])
    assert.deepEqual(texts(slides.at(-1)!), ['引用来源', `[1] planid 1·原文　片段 ${passage}`])
    assert.equal(count, 6)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})
