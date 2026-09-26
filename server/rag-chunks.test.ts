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

test('chapter, article and clause labels retain their hierarchy without rewriting text', () => {
  const text = [
    '  第一章 总则',
    '第一条 这是切块测试文本。',
    '（一）第一个事项。',
    '（二）第二个事项。',
    '第二条 重复正文。',
    '第二章 后续',
    '第三条 重复正文。',
  ].join('\r\n')
  const chunks = chunkText(text)
  verifySource(text, chunks)
  assert.deepEqual(
    chunks.map((chunk) => chunk.heading),
    [
      '第一章 总则',
      '第一章 总则 / 第一条',
      '第一章 总则 / 第一条 / （一）',
      '第一章 总则 / 第一条 / （二）',
      '第一章 总则 / 第二条',
      '第二章 后续',
      '第二章 后续 / 第三条',
    ],
  )
  assert.equal(chunks.filter((chunk) => chunk.text.includes('重复正文。')).length, 2)
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
  const text = '# 测试文档\n一、第一部分\n正文。\n（一）事项\n1. 子项。\n一、第一部分\n正文。'
  const chunks = chunkText(text)
  verifySource(text, chunks)
  assert.deepEqual(
    chunks.map((chunk) => chunk.heading),
    [
      '# 测试文档',
      '# 测试文档 / 一、第一部分',
      '# 测试文档 / 一、第一部分 / （一）',
      '# 测试文档 / 一、第一部分 / （一） / 1.',
      '# 测试文档 / 一、第一部分',
    ],
  )
})
