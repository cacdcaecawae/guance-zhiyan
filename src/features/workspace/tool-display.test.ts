import { expect, it } from 'vitest'
import type { AnswerPart } from '@/types'
import { processItems } from './tool-display'

const tool = (id: string, name: string, status: 'running' | 'done' | 'error' = 'done') =>
  ({ id, type: 'tool', name, input: '{"query":"糖果题"}', output: '', status }) as const
const think = (id: string): AnswerPart => ({ id, type: 'reasoning', step: 1, text: '想' })
const reply = (id: string): AnswerPart => ({ id, type: 'text', step: 1, text: '阶段回复' })
const titles = (parts: AnswerPart[], tailClosed = true) =>
  processItems(parts, tailClosed).map((item) => (item.kind === 'group' ? item.title : '回复'))

it('相邻的思考与工具成组，阶段回复把组切开', () => {
  expect(
    titles([think('r1'), tool('a', 'web_search'), reply('x'), think('r2'), tool('b', 'web_fetch')]),
  ).toEqual(['已搜索网页', '回复', '已访问网页'])
  expect(titles([think('r1')])).toEqual(['已完成分析'])
})

it('已结束的组按次数取前三类、不写次数；两类用“并”且省略第二个“已”，超过三类加“等”', () => {
  expect(
    titles([tool('a', 'web_fetch'), tool('b', 'web_search'), tool('c', 'web_search', 'error')]),
  ).toEqual(['已搜索网页并访问网页'])
  expect(titles([tool('a', 'create_file'), tool('b', 'bash')])).toEqual(['已生成文件并执行了命令'])
  expect(
    titles([
      tool('a', 'web_search'),
      tool('b', 'web_fetch'),
      tool('c', 'library_search'),
      tool('d', 'bash'),
    ]),
  ).toEqual(['已搜索网页，已访问网页，已检索文献库等'])
})

it('未结束的组写正在运行的工具与参数，没有运行工具时写“正在分析请求”', () => {
  expect(titles([think('r1'), tool('a', 'web_search', 'running')], false)).toEqual([
    '正在搜索网页 · 糖果题',
  ])
  expect(titles([tool('a', 'web_search'), think('r2')], false)).toEqual(['正在分析请求'])
})

it('已结束的组不把失败说成完成：全部失败写“…失败”，有工具被停止时加“已中断”', () => {
  const stopped = { ...tool('s', 'web_fetch'), status: 'stopped' } as const
  expect(titles([tool('a', 'create_file', 'error')])).toEqual(['生成文件失败'])
  expect(titles([tool('a', 'web_search'), tool('b', 'create_file', 'error')])).toEqual([
    '已搜索网页，生成文件失败',
  ])
  expect(titles([tool('a', 'web_fetch'), stopped])).toEqual(['已访问网页，已中断'])
  expect(titles([stopped])).toEqual(['已中断'])
  // 同一类里只要成功过一次就写“已…”，偶发的单次失败不另列
  expect(titles([tool('a', 'web_search', 'error'), tool('b', 'web_search')])).toEqual([
    '已搜索网页',
  ])
})
