import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkText, type Chunk } from './rag-chunks.ts'

function verifySource(text: string, chunks: Chunk[]) {
  let covered = 0
  let restored = ''
  for (const [ordinal, chunk] of chunks.entries()) {
    assert.equal(chunk.ordinal, ordinal)
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end))
    assert.ok(chunk.start <= covered, 'chunks must not leave gaps in the original text')
    assert.ok(chunk.end > covered, 'each chunk must add original content')
    assert.ok(chunk.text.length <= 1600)
    if (ordinal) {
      assert.ok(chunk.start > chunks[ordinal - 1].start)
      assert.ok(covered - chunk.start <= 160, 'overlap stays bounded')
    }
    restored += chunk.text.slice(covered - chunk.start)
    covered = chunk.end
  }
  assert.equal(restored, text)
}

test('empty input has no chunks; plain text and original whitespace remain unchanged', () => {
  for (const text of ['', ' \t\r\n\u3000']) assert.deepEqual(chunkText(text), [])
  const text = '  没有标题的普通资料。\r\n下一段仍是原文。\r\n'
  const chunks = chunkText(text)
  verifySource(text, chunks)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].heading, '')
  assert.deepEqual(chunkText(text), chunks)
})

const long = (label: string) => label + '切块测试正文。'.repeat(50)

test('heading lines join their body, clauses stay in their article, short sections merge', () => {
  const text = [
    '  第一章 总则',
    long('第一条 '),
    '（一）第一个事项。',
    '1. 子项。',
    long('第二条 '),
    '第二章 后续',
    '第三条 短条文。',
    '第四条 另一短条文。',
    long('第五条 '),
  ].join('\r\n')
  const chunks = chunkText(text)
  verifySource(text, chunks)
  assert.deepEqual(
    chunks.map((chunk) => chunk.heading),
    ['第一章 总则 / 第一条', '第一章 总则 / 第二条', '第二章 后续'],
    'a merged chunk is labelled with the headings its sections share',
  )
  assert.ok(chunks[0].text.startsWith('  第一章 总则\r\n第一条 '))
  assert.ok(chunks[0].text.includes('（一）第一个事项。\r\n1. 子项。'))
  assert.ok(
    chunks[2].text.startsWith('第二章 后续\r\n第三条 短条文。\r\n第四条 另一短条文。\r\n第五条 '),
  )
  assert.ok(chunks.every((chunk) => chunk.text.trim().length >= 300))
})

test('a short final section and a short document stay whole', () => {
  const text = [long('第一条 '), '第二条 本办法自发布之日起施行。'].join('\n')
  const chunks = chunkText(text)
  verifySource(text, chunks)
  assert.deepEqual(
    chunks.map((chunk) => chunk.heading),
    ['第一条', '第二条'],
  )
  const short = '第一章 总则\n第一条 短条文。\n第二条 另一短条文。'
  assert.deepEqual(
    chunkText(short).map((chunk) => [chunk.heading, chunk.text]),
    [['第一章 总则', short]],
  )
})

test('long continuous text has bounded overlap and never splits a Unicode surrogate pair', () => {
  const repeated = '甲😀乙'.repeat(1800)
  for (const text of [repeated, '导言' + repeated]) {
    const chunks = chunkText(text)
    verifySource(text, chunks)
    assert.ok(chunks.length > 1)
    assert.ok(chunks.every((chunk) => chunk.text.isWellFormed()))
  }
  const chunks = chunkText(repeated)
  assert.equal(chunks[0].text, chunks[1].text, 'identical text at different offsets is retained')
})

test('long sections prefer paragraph boundaries, then sentence endings, with inherited labels', () => {
  for (const separator of ['\r\n', '。']) {
    const text = '第一条 ' + ('测试'.repeat(200) + separator).repeat(12)
    const chunks = chunkText(text)
    verifySource(text, chunks)
    assert.ok(chunks.length > 1)
    assert.ok(chunks.every((chunk) => chunk.heading === '第一条'))
    assert.ok(chunks.slice(0, -1).every((chunk) => chunk.text.endsWith(separator)))
  }
  const text = '甲'.repeat(1599) + '\r\n' + '乙'.repeat(2000)
  const chunks = chunkText(text)
  verifySource(text, chunks)
  assert.ok(chunks.every((chunk) => !chunk.text.endsWith('\r')))
})

test('Markdown and numbered headings create boundaries; repeated sections are not deduplicated', () => {
  const body = long('')
  const text = `# 测试文档\n一、第一部分\n${body}\n（一）事项\n##### 小标题\n一、第一部分\n${body}`
  const chunks = chunkText(text)
  verifySource(text, chunks)
  assert.deepEqual(
    chunks.map((chunk) => chunk.heading),
    ['# 测试文档 / 一、第一部分', '# 测试文档 / 一、第一部分'],
  )
  assert.ok(chunks[0].text.endsWith('（一）事项\n##### 小标题\n'))
})
