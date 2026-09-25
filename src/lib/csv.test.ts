import { expect, test } from 'vitest'
import { parseCsv } from './csv'

test('解析引号、转义引号、引号内换行、CRLF 与 BOM', () => {
  expect(
    parseCsv('\uFEFF地区,说明\r\n北京,"含,逗号"\r\n上海,"第一行\n第二行"\n广州,"他说""好"""'),
  ).toEqual([
    ['地区', '说明'],
    ['北京', '含,逗号'],
    ['上海', '第一行\n第二行'],
    ['广州', '他说"好"'],
  ])
  expect(parseCsv('a,b\n')).toEqual([['a', 'b']])
  expect(parseCsv('a,\n')).toEqual([['a', '']])
})
