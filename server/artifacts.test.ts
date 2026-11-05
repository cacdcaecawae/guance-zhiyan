import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { parseCsv } from '../src/lib/csv.ts'
import { Artifacts } from './artifacts.ts'
import { LibraryStore } from './rag-store.ts'
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
      `**结论：**目标"十三五"，'快递进邮站'，China's 规划，"ok"，\`"代码" **原样**\`，再见[planid 7·原文](${a})与[planid 8·原文](${b})。`,
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
      '',
      '段落',
      '',
      '2024. 年度',
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
        // 工具给的现成引用（planid N·原文）在正文只留编号
        '正文加粗与强调，见[1]与统计局。',
        // 只把引号内含汉字的双引号换成弯引号，单引号与行内代码不动
        '结论：目标“十三五”，\'快递进邮站\'，China\'s 规划，"ok"，"代码" **原样**，再见[1]与[2]。',
        ...['第一条', '子条目', '甲', '乙', '地区', '目标', '上海', '4.5%', '左右', '江苏', '', ''],
        ...['原文摘录', '丙', '段', '落', '丁', '段落', '年度', '引用来源'],
        `[1]\tplanid 7·原文　片段 ${a.slice(-36).toLowerCase()}`,
        `[2]\tplanid 8·原文　片段 ${b.slice(-36)}`,
        '',
      ].join('\n'),
    )
    assert.doesNotMatch(text.replace('**原样**', ''), /[|*]|\]\(|\/api\/|---/)
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
      ['0', '1', '0', '0', '0', '0', '0'],
    )
    // 无序与有序列表用不同的编号定义；每个有序列表用自己的编号实例，从原文写的起始号编起
    const ids = levels.map((match) => match[2])
    const numbering = await zip.file('word/numbering.xml')!.async('string')
    const start = (id: string) =>
      new RegExp(`<w:num w:numId="${id}">(?:(?!</w:num>).)*<w:startOverride w:val="(\\d+)"/>`).exec(
        numbering,
      )?.[1]
    assert.notEqual(ids[0], ids[2])
    assert.equal(ids[2], ids[3])
    assert.equal(new Set(ids.slice(3)).size, 4)
    assert.deepEqual(ids.slice(2).map(start), ['1', '1', '1', '2', '2024'])
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
      ['江苏', 3, '{"键":"值"}\n"十三五"规划', '1234567890'],
      ['浙江', '1.10', '', '0.50'],
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
    // 表头以下的纯数字文本存为数值；有前导零、尾零或超过 9 位的保留文本；单元格文字原样，不换引号
    assert.deepEqual(
      [2, 3, 4].map((i) => [2, 3, 4].map((j) => sheet.getCell(i, j).value)),
      [
        [4.5, '长'.repeat(40), '00123'],
        [3, '{"键":"值"}\n"十三五"规划', '1234567890'],
        ['1.10', '', '0.50'],
      ],
    )
    // 工作表名遇 Excel 保留名或截断出半个代理对时改用默认名
    for (const name of ['History', '甲'.repeat(30) + '😀']) {
      const other = await files.create(user.id, session.id, name, 'xlsx', '[["a"]]')
      const otherBook = new ExcelJS.Workbook()
      await otherBook.xlsx.load(Uint8Array.from(await readFile(files.path(other.id))).buffer)
      assert.equal(otherBook.worksheets[0].name, '研究资料', name)
    }
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
        // 表格没有文末来源页，引用就地写成来源；库里没有这个片段时沿用链接文字与片段编号
        ['见 planid 1·原文　片段 00000000-0000-4000-8000-000000000000', '3\n4'],
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

test('generated files name cited passages by title, document number, passage and section', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-sources-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const library = new LibraryStore(store)
    const { versionId, chunks } = library.stage({
      id: '48470',
      title: '天元区国民经济和社会发展第十二个五年规划纲要',
      text: '# 六、产业发展\n\n## （一）优化提升第二产业\n\n轨道交通装备制造产业。\n',
    })
    library.publish(versionId, null)
    const user = store.user('test:sources', 'Test')
    const session = store.create(user.id)
    const unknown = '00000000-0000-4000-8000-000000000000'
    const cite = (id: string) => `[planid 48470·原文](/api/library/passages/${id})`
    // 与界面原文片段栏同样的写法；章节路径去掉 Markdown 标题符号
    const named =
      '《天元区国民经济和社会发展第十二个五年规划纲要》 文献编号 48470 · 片段 1 · 六、产业发展 / （一）优化提升第二产业'
    // 库里没有的片段（未发布、已删除）沿用链接文字与片段编号
    const fallback = `planid 48470·原文　片段 ${unknown}`
    const content = `# 报告\n\n“轨道交通装备制造产业。”${cite(chunks[0].id)}\n\n未入库${cite(unknown)}`
    const docx = await files.create(user.id, session.id, '报告', 'docx', content)
    assert.equal(
      await files.read(user.id, session.id, docx.id),
      [
        ...['报告', '“轨道交通装备制造产业。”[1]', '未入库[2]', '引用来源'],
        ...[`[1]\t${named}`, `[2]\t${fallback}`, ''],
      ].join('\n'),
    )
    const pptx = await files.create(user.id, session.id, '汇报', 'pptx', content)
    const zip = await JSZip.loadAsync(await readFile(files.path(pptx.id)))
    const last = zip.file(/^ppt\/slides\/slide\d+\.xml$/).length
    assert.deepEqual(texts(await zip.file(`ppt/slides/slide${last}.xml`)!.async('string')), [
      '引用来源',
      `[1] ${named}`,
      `[2] ${fallback}`,
    ])
    // 表格没有来源页，引用就地写成来源：Markdown 表格与 JSON 写法一样
    const xlsx = await files.create(
      user.id,
      session.id,
      '表格',
      'xlsx',
      `| 要点 | 出处 |\n| --- | --- |\n| 轨道交通 | ${cite(chunks[0].id)} |`,
    )
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(Uint8Array.from(await readFile(files.path(xlsx.id))).buffer)
    assert.deepEqual(book.worksheets[0].getRow(2).values, [, '轨道交通', named])
    const csv = await files.create(
      user.id,
      session.id,
      '表格',
      'csv',
      JSON.stringify([
        ['要点', '出处'],
        ['轨道交通', `“轨道交通装备制造产业。”${cite(chunks[0].id)}`],
      ]),
    )
    assert.equal(
      await files.read(user.id, session.id, csv.id),
      `"要点","出处"\r\n"轨道交通","“轨道交通装备制造产业。” ${named}"`,
    )
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('generated Office files keep their source for preview: Markdown for Word, the slide plan for decks, CSV for spreadsheets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-preview-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:preview', 'Test')
    const session = store.create(user.id)
    const markdown =
      '# 报告\n\n见[planid 1·原文](/api/library/passages/00000000-0000-4000-8000-000000000000)。'
    const docx = await files.create(user.id, session.id, '报告', 'docx', markdown)
    const pptx = await files.create(user.id, session.id, '汇报', 'pptx', markdown)
    const rows = [
      ['指标', '说明'],
      ['=1+1', '含,逗号与"引号"\n换行'],
      [12, ''],
    ]
    const xlsx = await files.create(user.id, session.id, '表格', 'xlsx', JSON.stringify(rows))
    const md = await files.create(user.id, session.id, '笔记', 'md', markdown)
    const external = await files.save(
      user.id,
      session.id,
      '外部.docx',
      await readFile(files.path(docx.id)),
    )
    assert.deepEqual(store.preview(user.id, docx.id), { kind: 'markdown', text: markdown })
    // 演示文稿的预览是与导出文件同一份分页
    const slides = store.preview(user.id, pptx.id)
    assert.equal(slides.kind, 'slides')
    assert.deepEqual(
      JSON.parse(slides.text).slides.map((slide: { layout: string; title: string }) => [
        slide.layout,
        slide.title,
      ]),
      [
        ['cover', '报告'],
        ['sources', '引用来源'],
      ],
    )
    const table = store.preview(user.id, xlsx.id)
    assert.equal(table.kind, 'csv')
    // 单元格保留原值（Excel 里公式样的文字也是文本），前端 parseCsv 原样读回
    assert.deepEqual(
      parseCsv(table.text),
      rows.map((row) => row.map(String)),
    )
    assert.deepEqual(
      store.artifacts(user.id, session.id).map((file) => [file.name, file.preview]),
      [
        ['报告.docx', true],
        ['汇报.pptx', true],
        ['表格.xlsx', true],
        ['笔记.md', undefined],
        ['外部.docx', undefined],
      ],
    )
    // md、csv 直接读文件预览；沙箱或外部生成的 Office 文件没有预览
    for (const file of [md, external])
      assert.throws(() => store.preview(user.id, file.id), { status: 404 })
    // 预览原文存在数据库里，同样计入文件配额
    const used =
      [docx, pptx, xlsx, md, external].reduce((sum, file) => sum + file.size, 0) +
      Buffer.byteLength(markdown) +
      Buffer.byteLength(slides.text) +
      Buffer.byteLength(table.text)
    const rest = 50 * 1024 * 1024 - used
    await assert.rejects(files.save(user.id, session.id, '填满.bin', Buffer.alloc(rest + 1)), {
      code: 'FILE_QUOTA',
    })
    await files.save(user.id, session.id, '填满.bin', Buffer.alloc(rest))
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

test('Markdown that would stall or overflow the parser is rejected quickly with the format error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-markdown-guard-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const inputs = [
      '*a'.repeat(60000),
      '_*'.repeat(40000) + 'a' + '*_'.repeat(40000),
      '~a'.repeat(60000),
      '[a]('.repeat(40000),
      '['.repeat(20000) + 'a' + ']'.repeat(20000),
      '>'.repeat(100000) + ' a',
      '1. '.repeat(50000) + 'a',
      Array.from({ length: 440 }, (_, i) => ' '.repeat(2 * i) + '- a').join('\n'),
      // 在数量限制之内，但层层嵌套的脚注里再套多层粗体仍会爆栈：解析出错同样转成格式错误码
      '[^a]: '.repeat(2900) + '*'.repeat(2990) + 'a' + '*'.repeat(2990),
    ]
    for (const [format, code] of [
      ['docx', 'FILE_INVALID_DOCX_CONTENT'],
      ['pptx', 'FILE_INVALID_PPTX_CONTENT'],
      ['xlsx', 'FILE_INVALID_TABLE'],
      ['csv', 'FILE_INVALID_TABLE'],
    ] as const)
      for (const content of inputs) {
        const start = performance.now()
        await assert.rejects(files.create(user.id, session.id, '报告', format, content), { code })
        assert.ok(performance.now() - start < 2000, `${format} ${content.slice(0, 8)}`)
      }
    assert.match(toolError('FILE_INVALID_DOCX_CONTENT'), /嵌套/)
    assert.equal(store.artifacts(user.id, session.id).length, 0)
    // 真实报告的写法远在上限之内：每行都有粗体标签、引用与原文链接的长报告照常生成
    const line = `- **标签：**内容“十三五”[planid 1·原文](/api/library/passages/00000000-0000-4000-8000-000000000000)`
    const report = [
      '# 报告',
      ...Array.from({ length: 900 }, (_, i) => `## ${i}\n${line}\n> 引用`),
    ].join('\n')
    const start = performance.now()
    await files.create(user.id, session.id, '报告', 'docx', report)
    assert.ok(performance.now() - start < 5000)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('Markdown with too many lines is rejected quickly instead of exhausting time and memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-markdown-lines-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const inputs = [
      'a\n'.repeat(100000),
      'a  \n'.repeat(50000),
      'a\\\n'.repeat(66000),
      'a\r'.repeat(100000),
      '- 项\n'.repeat(33000),
      '## 节\n'.repeat(28000),
    ]
    for (const [format, code] of [
      ['docx', 'FILE_INVALID_DOCX_CONTENT'],
      ['pptx', 'FILE_INVALID_PPTX_CONTENT'],
      ['xlsx', 'FILE_INVALID_TABLE'],
      ['csv', 'FILE_INVALID_TABLE'],
    ] as const)
      for (const content of inputs) {
        const start = performance.now()
        await assert.rejects(files.create(user.id, session.id, '报告', format, content), { code })
        assert.ok(
          performance.now() - start < 2000,
          `${format} ${JSON.stringify(content.slice(0, 6))}`,
        )
      }
    assert.equal(store.artifacts(user.id, session.id).length, 0)
    // 5000 行以内照常生成
    await files.create(user.id, session.id, '报告', 'docx', '- 项\n'.repeat(4999))
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('setext underlines do not turn body lines into headings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-setext-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const docx = await files.create(
      user.id,
      session.id,
      '报告',
      'docx',
      '# 报告\n正文\n---\n下一段\n===\n## 一\n## 二',
    )
    const zip = await JSZip.loadAsync(await readFile(files.path(docx.id)))
    const xml = await zip.file('word/document.xml')!.async('string')
    assert.equal(await files.read(user.id, session.id, docx.id), '报告\n正文\n下一段\n一\n二\n')
    assert.deepEqual(
      [...xml.matchAll(/<w:pStyle w:val="(\w+)"\/>/g)].map((match) => match[1]),
      ['Title', 'Heading1', 'Heading1'],
    )
    const pptx = await files.create(
      user.id,
      session.id,
      '汇报',
      'pptx',
      '# 汇报\n## 一\n要点\n---\n续写',
    )
    const deck = await JSZip.loadAsync(await readFile(files.path(pptx.id)))
    assert.equal(deck.file(/^ppt\/slides\/slide\d+\.xml$/).length, 2)
    assert.deepEqual(texts(await deck.file('ppt/slides/slide2.xml')!.async('string')), [
      '一',
      '要点',
      '续写',
    ])
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('file names that cannot be written into Office XML are rejected for every format', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-file-name-xml-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    for (const format of ['docx', 'pptx', 'xlsx', 'csv', 'md'] as const)
      for (const name of ['报告￾', '报告\ud800'])
        await assert.rejects(
          files.create(user.id, session.id, name, format, '[["正文"]]'),
          { code: 'FILE_INVALID_NAME' },
          `${format} ${JSON.stringify(name)}`,
        )
    assert.equal(store.artifacts(user.id, session.id).length, 0)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('decks cap list levels and start numbers to what PowerPoint opens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-pptx-caps-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const nested = Array.from({ length: 10 }, (_, i) => `${'  '.repeat(i)}- 第${i + 1}层`)
    const content = ['# 汇报', '## 一', ...nested, '', '99999. 大号'].join('\n')
    const artifact = await files.create(user.id, session.id, '汇报', 'pptx', content)
    const zip = await JSZip.loadAsync(await readFile(files.path(artifact.id)))
    const xml = await zip.file('ppt/slides/slide2.xml')!.async('string')
    const levels = [...xml.matchAll(/<a:pPr lvl="(\d+)"/g)].map((match) => Number(match[1]))
    assert.equal(Math.max(...levels), 8)
    assert.match(xml, /<a:buAutoNum type="arabicPeriod" startAt="32767"\/>/)
    // Word 的编号起始号同样封顶
    const word = await files.create(user.id, session.id, '报告', 'docx', '99999. 大号')
    const numbering = await (
      await JSZip.loadAsync(await readFile(files.path(word.id)))
    )
      .file('word/numbering.xml')!
      .async('string')
    assert.match(numbering, /<w:start w:val="32767"\/>/)
    assert.doesNotMatch(numbering, /99999/)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('Word and deck tables over 2000 rows or 50 columns are rejected like spreadsheets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-table-columns-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:office-text', 'Test')
    const session = store.create(user.id)
    const table = (columns: number) =>
      [
        `|${' 列 |'.repeat(columns)}`,
        `|${' --- |'.repeat(columns)}`,
        `|${' 值 |'.repeat(columns)}`,
      ].join('\n')
    const long = (rows: number) => ['| 列 |', '| --- |', ...Array(rows).fill('| 值 |')].join('\n')
    for (const format of ['docx', 'pptx'] as const) {
      for (const content of [table(51), long(2000)])
        await assert.rejects(files.create(user.id, session.id, '表', format, content), {
          code: 'FILE_INVALID_TABLE',
        })
      await files.create(user.id, session.id, '表', format, table(50))
    }
    await files.create(user.id, session.id, '表', 'docx', long(1999))
    assert.equal(store.artifacts(user.id, session.id).length, 3)
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
    const long = '长'.repeat(800)
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
      ['汇报材料', '长三角规划对比'],
      ['一、背景', '要点 &amp; &lt;原文&gt;', '普通段落 😀'],
    ])
    assert.deepEqual(slides[2], ['二、主要做法', '1. 产业', ...items.slice(0, 14)])
    assert.deepEqual(slides[3], ['二、主要做法', '1. 产业（续）', items[14]])
    assert.deepEqual(slides[4], ['二、主要做法', '2. 长段', long.slice(0, 728)])
    assert.deepEqual(slides[5], ['二、主要做法', '2. 长段（续）', long.slice(728)])
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
    assert.deepEqual(texts(slides[0]), ['汇报材料', '汇报', '副标题', '依据文献：某规划'])
    assert.doesNotMatch(slides[0], /type="slidenum"/)
    // “> 出处：[…]”只剩引用编号，接到上一行末尾；本页引用的文献写在页脚
    assert.deepEqual(texts(slides[1]), [
      ...['一、要点', '加粗', '说明', '[1]', '子要点', '甲', '乙', '[1]'],
      `来源：[1]planid 1·原文　片段 ${passage}`,
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
    // 只有引用注的“二、比较”不单独成页：作章节名显示在其下各页标题上方，引用注并入下一页
    // 表格单独成页，按估算行高切开，每页重复表头，标题标“（续）”；表后的文字另起一页
    const tables = slides.filter((xml) => xml.includes('<a:tbl>'))
    assert.equal(tables.length, 3)
    assert.deepEqual(
      tables.map((xml) => texts(xml).slice(0, 4)),
      [
        ['二、比较', '对比', '地区', '目标'],
        ['二、比较', '对比（续）', '地区', '目标'],
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
    assert.equal(count, 7)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('decks pick layouts by content: cover with the basis line, cards, label rows, a single highlighted row and source footers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-pptx-layout-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const library = new LibraryStore(store)
    const { versionId, chunks } = library.stage({
      id: '24177',
      title: '五指山市  国民经济和社会发展第十四个五年规划纲要',
      text: `# 一、目标\n\n${'甲'.repeat(400)}\n\n# 二、保障\n\n${'乙'.repeat(400)}\n`,
    })
    library.publish(versionId, null)
    assert.equal(chunks.length, 2)
    const user = store.user('test:layouts', 'Test')
    const session = store.create(user.id)
    const cite = (id: string) => `[planid 24177·原文](/api/library/passages/${id})`
    const long = '规划实施'.repeat(20)
    const content = [
      '# 五指山市实施保障汇报',
      '依据文献：《五指山市规划纲要》（planid 24177）',
      '# 一、要点',
      `- **产业升级**："推动制造业高端化"${cite(chunks[0].id)}`,
      `- **数字转型**："建设"数字城市"，推进产业化"`,
      `  ${cite(chunks[1].id)}`,
      '# 二、细则',
      `- **甲项**：${long}${cite(chunks[0].id)}`,
      '- 乙项：短说明',
      '# 三、单条',
      `- **总目标**："确保"十四五"规划明确的各项目标任务落实落细落到位。"（出处：${cite(chunks[1].id)}）`,
    ].join('\n')
    const pptx = await files.create(user.id, session.id, '汇报', 'pptx', content)
    type Plan = {
      layout: string
      title: string
      foot?: string
      lines?: { text: string }[][]
      rows?: { label: { text: string }[]; body: { text: string }[] }[]
    }
    const plan: Plan[] = JSON.parse(store.preview(user.id, pptx.id).text).slides
    const join = (segs: { text: string }[]) => segs.map((seg) => seg.text).join('')
    // 开头的 # 标题不是“一、”这类章节编号：作封面，其下的依据文献也上封面，不单独成页
    assert.deepEqual(
      plan.map((slide) => [slide.layout, slide.title]),
      [
        ['cover', '五指山市实施保障汇报'],
        ['cards', '一、要点'],
        ['rows', '二、细则'],
        ['rows', '三、单条'],
        ['sources', '引用来源'],
      ],
    )
    assert.deepEqual(plan[0].lines!.map(join), ['依据文献：《五指山市规划纲要》（planid 24177）'])
    // 2–4 条短说明排成卡片；另起一行的引用编号接到上一行末尾；引文里的引号按内外层配对
    assert.deepEqual(
      plan[1].rows!.map((row) => [join(row.label), join(row.body)]),
      [
        ['产业升级', '“推动制造业高端化”[1]'],
        ['数字转型', '“建设‘数字城市’，推进产业化”[2]'],
      ],
    )
    // 页脚写本页引用的文献，同一文献的片段并在一起；标题去掉汉字间的空白
    assert.equal(
      plan[1].foot,
      '来源：[1][2]《五指山市国民经济和社会发展第十四个五年规划纲要》 文献编号 24177 · 片段 1、2',
    )
    // 说明较长时排成标签行；列表里不加粗的“标签：说明”也算
    assert.deepEqual(
      plan[2].rows!.map((row) => [join(row.label), join(row.body)]),
      [
        ['甲项', `${long}[1]`],
        ['乙项', '短说明'],
      ],
    )
    // “（出处：[…]）”只留编号
    assert.deepEqual(
      plan[3].rows!.map((row) => join(row.body)),
      ['“确保‘十四五’规划明确的各项目标任务落实落细落到位。”[2]'],
    )
    const zip = await JSZip.loadAsync(await readFile(files.path(pptx.id)))
    const cover = await zip.file('ppt/slides/slide1.xml')!.async('string')
    assert.deepEqual(texts(cover), [
      '汇报材料',
      '五指山市实施保障汇报',
      '依据文献：《五指山市规划纲要》（planid 24177）',
    ])
    assert.match(cover, /<p:bg>.*232327/s)
    assert.match(await zip.file('ppt/slides/slide2.xml')!.async('string'), /roundRect/)
    // Word 共用同样的引号与引用编号处理
    const docx = await files.create(user.id, session.id, '报告', 'docx', content)
    const text = await files.read(user.id, session.id, docx.id)
    assert.match(text, /“建设‘数字城市’，推进产业化”\[2\]\n/)
    assert.match(text, /落到位。”\[2\]\n/)
    assert.doesNotMatch(text, /出处/)
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})

test('straight quotes pair by position unless an inner quote sits inside a longer quotation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-quotes-test-'))
  const store = new Store(root)
  try {
    const files = new Artifacts(store)
    const user = store.user('test:quotes', 'Test')
    const session = store.create(user.id)
    const lines = [
      '"十三五"和"十四五"',
      '"推动上级"一把手"抓好下级"一把手"，着力破解难题。"',
      'He said "hi" and "bye"',
      '只有一个"引号',
    ]
    const docx = await files.create(user.id, session.id, '引号', 'docx', lines.join('\n\n'))
    assert.deepEqual((await files.read(user.id, session.id, docx.id)).split('\n').slice(0, 4), [
      '“十三五”和“十四五”',
      '“推动上级‘一把手’抓好下级‘一把手’，着力破解难题。”',
      'He said "hi" and "bye"',
      '只有一个"引号',
    ])
  } finally {
    store.close()
    await rm(root, { recursive: true })
  }
})
