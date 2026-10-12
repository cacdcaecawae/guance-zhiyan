import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withoutSentences } from './answer-check.ts'

test('removed sentences leave tables intact and drop items left with only a citation', () => {
  const cite = '[planid 1·原文](/api/library/passages/01234567-89ab-5def-a123-456789abcdef)'
  const text = [
    '依据《测试规划》（planid 1）。',
    `- 目标：“到期末达到九成。”${cite}`,
    `- 补充：本地区紧邻省会。${cite}`,
    '| 指标 | 属性 |',
    '|---|---|',
    '| 用水量 | 约束性 |',
  ].join('\n')
  assert.equal(
    withoutSentences(text, ['补充：本地区紧邻省会。', '约束性']),
    [
      '依据《测试规划》（planid 1）。',
      `- 目标：“到期末达到九成。”${cite}`,
      '| 指标 | 属性 |',
      '|---|---|',
      '| 用水量 |  |',
    ].join('\n'),
  )
  assert.equal(withoutSentences(text, []), text)
})
