import { expect, test } from 'vitest'
import { parseCsv } from './csv'

test('解析引号、转义引号、引号内换行、CRLF 与 BOM', () => {
  expect(
    parseCsv('\uFEFF地区,说明\r\n北京,"含,逗号"\r\n上海,"第一行\n第二行"\n广州,"他说""好"""').rows,
  ).toEqual([
    ['地区', '说明'],
    ['北京', '含,逗号'],
    ['上海', '第一行\n第二行'],
    ['广州', '他说"好"'],
  ])
  expect(parseCsv('a,b\n').rows).toEqual([['a', 'b']])
  expect(parseCsv('a,\n').rows).toEqual([['a', '']])
})

test('跳过空行；字段中间的引号不开启引号模式', () => {
  expect(parseCsv('a,b\n\r\n\nc,d').rows).toEqual([
    ['a', 'b'],
    ['c', 'd'],
  ])
  expect(parseCsv('5"屏,说明\n下一行,x').rows).toEqual([
    ['5"屏', '说明'],
    ['下一行', 'x'],
  ])
})

test.each(['\n', '\r\n', '\r'])('保留空表头与中间、末尾的引号空字段：%j', (newline) => {
  const rows = [[''], ['2026-01'], [''], ['2026-03'], ['']]
  // The file generator quotes every cell and includes a BOM, with no trailing newline.
  const csv = '\uFEFF' + rows.map(([value]) => `"${value}"`).join(newline)
  expect(parseCsv(csv).rows).toEqual(rows)
  expect(parseCsv(csv + newline).rows).toEqual(rows)
  expect(parseCsv(`${newline}""${newline}${newline}`).rows).toEqual([['']])
})

test('空引号字段本身也是记录，多个空字段与转义引号保持原值', () => {
  expect(parseCsv('""').rows).toEqual([['']])
  expect(parseCsv('"",\n,""\n""""').rows).toEqual([['', ''], ['', ''], ['"']])
})

test('2 MiB 预览只保留所需行列，但总数覆盖整个文件', () => {
  const tall = parseCsv('a\n'.repeat(1_048_576), 501, 50)
  expect(tall.rows).toHaveLength(501)
  expect(tall.totalRows).toBe(1_048_576)
  expect(tall.columns).toBe(1)
  const wide = parseCsv(','.repeat(2_097_151), 501, 50)
  expect(wide.rows).toEqual([Array(50).fill('')])
  expect(wide.totalRows).toBe(1)
  expect(wide.columns).toBe(2_097_152)
})

test.each([
  ['h\nkept,a"b\nc,d,e', 3, 3],
  ['h\nx\na"b,c\nz', 4, 2],
  ['h\nx\n"a\r\nb",c\nz', 4, 2],
  ['\uFEFF"",header\r\n"line\nwith""quote",b,c\r\n\r\n"",\r\nlate,"a,b",c,d', 4, 4],
] as const)('丢弃的行列仍按引号规则准确计数：%j', (text, totalRows, columns) => {
  const full = parseCsv(text)
  const bounded = parseCsv(text, 2, 1)
  expect(bounded).toEqual({
    rows: full.rows.slice(0, 2).map((row) => row.slice(0, 1)),
    totalRows,
    columns,
  })
})

test('零保留量只统计，空文件不算一行', () => {
  expect(parseCsv('"",x\nlast,"line\nend"', 0, 0)).toEqual({
    rows: [],
    totalRows: 2,
    columns: 2,
  })
  expect(parseCsv('\uFEFF\r\n\n')).toEqual({ rows: [], totalRows: 0, columns: 0 })
})
