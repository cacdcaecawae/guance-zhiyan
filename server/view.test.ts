import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/types/index.ts'
import { checkCitations, trimAnswers } from './view.ts'

const returned = '01234567-89ab-5def-a123-456789abcdef'
const invented = '00000000-0000-5000-a000-000000000000'
const path = (id: string) => `/api/library/passages/${id}`

test('only passages returned by library tools stay linked, in any link syntax and in reasoning', () => {
  const messages: Message[] = [
    {
      id: 'turn-1',
      role: 'assistant',
      question: '问题',
      status: 'done',
      parts: [
        { id: 'r0', type: 'reasoning', step: 0, text: `先写引用[原文](${path(returned)})` },
        {
          id: 't1',
          type: 'tool',
          name: 'library_search',
          input: '{"query":"测试"}',
          output: [
            '共享文献库检索结果：',
            JSON.stringify({
              id: returned.toUpperCase(),
              link: path(returned.toUpperCase()),
              text: `正文或标题里出现的路径不算 ${path(invented)}`,
            }),
            JSON.stringify({ id: returned, link: path(invented) }),
            `非 JSON 行 ${path(invented)}`,
          ].join('\n'),
          status: 'done',
        },
        {
          id: 'x1',
          type: 'text',
          step: 1,
          text: [
            `有效[原文](${path(returned)})`,
            `带标题[原文](${path(invented)} "标题")`,
            `尖括号[原文](<${path(invented)}>)`,
            `引用式[原文][r]\n\n[r]: ${path(invented)}`,
            `标签含括号[原文[1]](${path(invented)})`,
          ].join('\n\n'),
        },
        { id: 'r1', type: 'reasoning', step: 1, text: `思考中编造[原文](${path(invented)})` },
      ],
    },
    {
      id: 'turn-2',
      role: 'assistant',
      question: '追问',
      status: 'done',
      parts: [
        {
          id: 't2',
          type: 'tool',
          name: 'web_fetch',
          input: '{}',
          output: path(invented),
          status: 'done',
        },
        { id: 'x2', type: 'text', step: 0, text: `网页里出现的编号不算[原文](${path(invented)})` },
        { id: 'x3', type: 'text', step: 0, text: `上一轮返回的仍可引用[原文](${path(returned)})` },
      ],
    },
  ]
  checkCitations(messages)
  const texts = messages.flatMap((message) =>
    message.role === 'assistant'
      ? message.parts.flatMap((part) => (part.type === 'tool' ? [] : [part.text]))
      : [],
  )
  const all = texts.join('\n')
  assert.ok(!all.includes(invented), 'unreturned passages are removed in every syntax')
  assert.equal(texts[0], '先写引用[原文]()', 'a citation before any search result is not kept')
  assert.ok(texts[1].startsWith(`有效[原文](${path(returned)})`))
  assert.equal(texts.at(-1), `上一轮返回的仍可引用[原文](${path(returned)})`)
  const once = structuredClone(messages)
  checkCitations(messages)
  assert.deepEqual(messages, once, 'checking again changes nothing')
})

test('incremental citation checks reuse validated text but retain ordered history authorization', () => {
  const later = '11111111-1111-5111-a111-111111111111'
  const messages: Message[] = [
    {
      id: 'turn-1',
      role: 'assistant',
      question: 'first',
      status: 'done',
      parts: [
        {
          id: 'tool-1',
          type: 'tool',
          name: 'library_search',
          input: '{}',
          status: 'done',
          output: JSON.stringify({ id: returned, link: path(returned) }),
        },
        { id: 'old-text', type: 'text', step: 0, text: `Previous [source](${path(returned)})` },
      ],
    },
    { id: 'question-2', role: 'user', text: 'continue' },
    {
      id: 'turn-2',
      role: 'assistant',
      question: 'continue',
      status: 'loading',
      parts: [
        {
          id: 'early',
          type: 'reasoning',
          step: 0,
          text: `Earlier result ${path(returned)}; not returned yet ${path(later)}`,
        },
        {
          id: 'tool-2',
          type: 'tool',
          name: 'library_get',
          input: '{}',
          status: 'done',
          output: JSON.stringify({ id: later, link: path(later) }),
        },
        {
          id: 'new-text',
          type: 'text',
          step: 1,
          text: `Old ${path(returned)}; new ${path(later)}; invented ${path(invented)}`,
        },
      ],
    },
  ]
  const expected = structuredClone(messages)
  checkCitations(expected)
  const prefix = messages[0]
  assert.ok(prefix.role === 'assistant')
  for (const part of prefix.parts) Object.freeze(part)
  checkCitations(messages, 2)
  assert.deepEqual(messages, expected)
})

test('completed library answers drop free commentary after the citations', () => {
  const passage = '实施行业扶贫10大类137个项目，规划总投资526亿元，项目覆盖贫困户2.1万户6.34万人。'
  const tool = {
    id: 't1',
    type: 'tool' as const,
    name: 'library_search',
    input: '{"query":"扶贫"}',
    output: [
      '共享文献库检索结果：',
      JSON.stringify({ id: returned, link: path(returned), text: passage }),
    ].join('\n'),
    status: 'done' as const,
  }
  const cite = `[planid 5116·原文](${path(returned)})`
  const answer = [
    '依据《城固县“十三五”规划纲要》（planid 5116），文献库中只有这一篇城固县文件。',
    '## 一、城固县（含各镇）行业扶贫与基础设施配套项目',
    `- **项目**：“实施行业扶贫10大类137个项目” ${cite}`,
    '| 工程 | 原文 | 出处 |',
    '|---|---|---|',
    `| 行业扶贫 | “规划总投资526亿元” | ${cite} |`,
    '**2. 产业项目**（十三五纲要）',
    '**贫困人口覆盖**：“项目覆盖贫困户2.1万户6.34万人。”',
    '文献库中未检索到城固县“十三五”扶贫项目的完成情况。',
    '**口径说明**：上述内容反映了当时主流扶贫方式，次年还部署了社区教育示范区。',
    '## 分析（推断）',
    '1. 基础设施是投入重心。',
  ]
  const make = (question: string, text: string): Message => ({
    id: 'turn-1',
    role: 'assistant',
    question,
    status: 'done',
    parts: [tool, { id: 'x1', type: 'text', step: 1, text }],
  })
  const textOf = (message: Message) =>
    message.role === 'assistant' ? (message.parts.at(-1) as { text: string }).text : ''

  const facts = [make('城固县扶贫有哪些项目？', answer.join('\n'))]
  trimAnswers(facts)
  assert.deepEqual(
    textOf(facts[0]).split('\n'),
    answer.slice(0, 9),
    'keeps the opening, cited lines, cited tables, headings (with a source note), labelled passage text and not-found notes; drops commentary and unrequested analysis',
  )

  const report = [make('城固县2016年政府工作报告提到哪些扶贫项目？', answer.join('\n'))]
  trimAnswers(report)
  assert.equal(textOf(report[0]), textOf(facts[0]), 'a government work report question is factual')

  const analysis = [make('分析城固县扶贫的投入重心。', answer.join('\n'))]
  trimAnswers(analysis)
  assert.equal(
    textOf(analysis[0]),
    answer.join('\n'),
    'questions asking for analysis are left whole',
  )

  const refusal = `库中没有“十五五”规划，无法列出。\n仅供参考：${cite}`
  const loading = { ...make('问题', answer.join('\n')), status: 'loading' as const }
  const untouched = [make('“十五五”有哪些产业？', refusal), loading]
  trimAnswers(untouched)
  assert.equal(textOf(untouched[0]), refusal, 'fewer than two cited lines are left whole')
  assert.equal(textOf(untouched[1]), answer.join('\n'), 'answers still streaming are not trimmed')
})
