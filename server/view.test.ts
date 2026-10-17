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
      JSON.stringify({ id: returned, link: path(returned), documentId: '5116', text: passage }),
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

test('trimming uses results up to each answer and keeps web sources, bare tables and stated gaps only', () => {
  const passage = '实施行业扶贫10大类137个项目，规划总投资526亿元，项目覆盖贫困户2.1万户6.34万人。'
  const later = '易地扶贫搬迁安置点配套建设产业园区和社区工厂，带动搬迁群众就近就业。'
  const search = (id: string, text: string) => ({
    id,
    type: 'tool' as const,
    name: 'library_search',
    input: '{"query":"扶贫"}',
    output: [
      '共享文献库检索结果：',
      JSON.stringify({ id: returned, link: path(returned), text }),
    ].join('\n'),
    status: 'done' as const,
  })
  const cite = `[planid 5116·原文](${path(returned)})`
  const answer = [
    `- **项目**：“实施行业扶贫10大类137个项目” ${cite}`,
    '工程 | 原文 | 出处',
    '--- | --- | ---',
    `行业扶贫 | “规划总投资526亿元” | ${cite}`,
    '据新华网报道，项目已全部开工。[新华网](https://www.news.cn/x)',
    '项目覆盖贫困户21万户634万人。',
    later,
    '文献库中未检索到项目完成情况；因此可以确认所有项目均未实施。',
    '## 分析（推断）',
    '### 主要影响',
    '扶贫成效显著。',
  ]
  const messages: Message[] = [
    {
      id: 'turn-1',
      role: 'assistant',
      question: '城固县扶贫有哪些项目？',
      status: 'done',
      parts: [search('t1', passage), { id: 'x1', type: 'text', step: 1, text: answer.join('\n') }],
    },
    {
      id: 'turn-2',
      role: 'assistant',
      question: '搬迁安置怎么安排？',
      status: 'done',
      parts: [search('t2', later), { id: 'x2', type: 'text', step: 1, text: '只有一条引用' }],
    },
  ]
  trimAnswers(messages)
  const text = messages[0].role === 'assistant' ? messages[0].parts[1] : undefined
  assert.deepEqual(
    text?.type === 'text' && text.text.split('\n'),
    [...answer.slice(0, 5), '文献库中未检索到项目完成情况；'],
    'drops a misquoted number, passages returned only in a later turn, the unsupported conclusion and the analysis subsection',
  )
})

test('trimming keeps Latin terms distinct, counts only rendered citation links and leaves image questions whole', () => {
  const passage = '完善GDP统一核算制度并加强地区生产总值质量管理。'
  const tool = {
    id: 't1',
    type: 'tool' as const,
    name: 'library_search',
    input: '{"query":"核算"}',
    output: [
      '共享文献库检索结果：',
      JSON.stringify({ id: returned, link: path(returned), text: passage }),
    ].join('\n'),
    status: 'done' as const,
  }
  const cite = `[planid 5116·原文](${path(returned)})`
  const answer = [
    `- **核算**：“完善GDP统一核算制度” ${cite}`,
    `- **质量**：“加强地区生产总值质量管理” ${cite}`,
    '完善GNP统一核算制度并加强地区生产总值质量管理。',
    `项目均已完成 ${path(returned)}`,
    passage,
  ]
  const make = (extra: Partial<Message> = {}): Message =>
    ({
      id: 'turn-1',
      role: 'assistant',
      question: '统计核算有哪些要求？',
      status: 'done',
      parts: [tool, { id: 'x1', type: 'text', step: 1, text: answer.join('\n') }],
      ...extra,
    }) as Message
  const textOf = (message: Message) =>
    message.role === 'assistant' ? (message.parts.at(-1) as { text: string }).text : ''

  const facts = [make()]
  trimAnswers(facts)
  assert.deepEqual(
    textOf(facts[0]).split('\n'),
    [answer[0], answer[1], passage],
    'drops a changed Latin term and a line whose only "citation" is a bare path',
  )

  const pictured = [make({ question: '', questionImages: [{ id: 'i1', width: 1, height: 1 }] })]
  trimAnswers(pictured)
  assert.equal(textOf(pictured[0]), answer.join('\n'), 'a question in an image is left whole')
})

test('trimming drops uncited sentences giving numbers or counts the results and question never gave', () => {
  const passage =
    '划分为禁止开发区、限制开发区、优化开发区和重点开发区四大类，全市人才总量达到12.5万人，人才投入10,000万元，共实施一百六十项重点工程，详见第十一章。'
  const search = {
    id: 't1',
    type: 'tool' as const,
    name: 'library_search',
    input: '{"query":"人才"}',
    output: JSON.stringify({
      id: returned,
      link: path(returned),
      documentId: '11729',
      title: '莱芜市2010年政府工作报告',
      heading: '第九章 人才',
      text: passage,
    }),
    status: 'done' as const,
  }
  const cite = `[planid 11729·原文](${path(returned)})`
  const answer = [
    '依据《莱芜市2010年政府工作报告》（planid 11729）。报告共六个方面，莱芜市2019年撤市设区。',
    '围绕你关注的三个方面和2025年目标整理如下：',
    '## 指标 | 2019年撤市设区',
    '| 指标 | 目标 |',
    '|---|---|',
    '| 人才总量 | 2030年达到20万人〔片1〕 |',
    '## 2019年规划 | 六大任务',
    '文献库中未检索到总投资10,000万元以上的项目。',
    '为您说明：报告共六个方面。',
    '该市2019年撤市设区。文献库中未检索到2030年的人才目标，但当年已完成13.5万人培训。',
    '13.5万人才完成培训。',
    '参见[2019年撤市设区公告](#note)。',
    '共实施六十项重点工程。',
    '## 五、人才开发（“六大抓手”）',
    `- **总量**：“全市人才总量达到12.5万人” ${cite}`,
    '**四、重点开发区**（第九章，四大类）',
    '**二、总体要求**（第一章）',
    '人才投入10000万元。',
    '## 产业 | 2019年撤市设区',
    `- **分区**：“划分为禁止开发区、限制开发区” ${cite}`,
  ]
  const messages: Message[] = [
    { id: 'u1', role: 'user', text: '莱芜市2025年人才目标是什么？' },
    {
      id: 'turn-1',
      role: 'assistant',
      question: '莱芜市2025年人才目标是什么？',
      status: 'done',
      parts: [search, { id: 'x1', type: 'text', step: 1, text: answer.join('\n') }],
    },
  ]
  trimAnswers(messages)
  const text = messages[1].role === 'assistant' ? messages[1].parts[1] : undefined
  assert.deepEqual(
    text?.type === 'text' && text.text.split('\n'),
    [
      '依据《莱芜市2010年政府工作报告》（planid 11729）。',
      answer[1],
      answer[3],
      answer[4],
      answer[5],
      answer[7],
      '文献库中未检索到2030年的人才目标。',
      answer[14],
      answer[15],
      answer[17],
      answer[19],
    ],
    'checks each sentence and, in a not-found sentence, each clause (a thousands separator is not a clause break); keeps tables whole, sourced numbers (10,000 = 10000), numbered headings and counts of the asked aspects; drops invented counts and years (also in link text and at a line start), "第一章" when only "第十一章" was returned, "六十项" when only "一百六十项" was, and a heading with a pipe, even right above or below a table',
  )
})

test('number and count trimming reads tables, list numbers and thousands separators as written', () => {
  const passage =
    '全市人才总量达到12万人，建设产业园区和配套设施，总投资10,000万元，共实施一百六十项重点工程。'
  const cite = `[planid 1·原文](${path(returned)})`
  const trim = (head: string[]) => {
    const messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        question: '该市有哪些安排？',
        status: 'done',
        parts: [
          {
            id: 't1',
            type: 'tool',
            name: 'library_search',
            input: '{}',
            status: 'done',
            output: JSON.stringify({
              id: returned,
              documentId: '1',
              heading: '第三章 保障',
              text: passage,
            }),
          },
          {
            id: 'x1',
            type: 'text',
            step: 1,
            text: [
              ...head,
              `- 人才：“人才总量达到12万人” ${cite}`,
              `- 园区：“建设产业园区” ${cite}`,
            ].join('\n'),
          },
        ],
      },
    ]
    trimAnswers(messages)
    const part = messages[0].role === 'assistant' ? messages[0].parts[1] : undefined
    return part?.type === 'text' ? part.text.split('\n').slice(0, -2) : []
  }
  const table = ['| 指标 | 目标 |', '|---|---|', '| 人才 | 2030年20万人 |']
  const other = ['| 项目 | 投资 |', '| --- | --- |', '| 园区 | 2031年30亿元 |']
  // [lines before the citations, lines kept]
  const cases: [string[], string[]][] = [
    [
      [...table, '## 2019年 | 六大任务', ...other],
      [...table, ...other],
    ],
    [['## 2019年 | 表', ...table, '## 2019年规划 | 六大任务'], table],
    [
      ['指标 | 目标', '--- | ---', '人才 | 2030年20万人'],
      ['指标 | 目标', '--- | ---', '人才 | 2030年20万人'],
    ],
    [
      ['| 指标 | 目标 |', '|:---|---:|', '| 人才 | 2030年20万人 |'],
      ['| 指标 | 目标 |', '|:---|---:|', '| 人才 | 2030年20万人 |'],
    ],
    [
      ['总投资10，000万元。', '总投资10000万元。'],
      ['总投资10，000万元。', '总投资10000万元。'],
    ],
    [
      ['未检索到总投资10，000万元的项目，但该市2019年撤市设区。'],
      ['未检索到总投资10，000万元的项目。'],
    ],
    [['未检索到相关资料,但该市2019年撤市设区。'], ['未检索到相关资料。']],
    [['2019，2020年分别撤市设区。'], []],
    [
      [
        '## 27. 保障措施',
        '- 27. 保障措施',
        '**27. 保障措施**',
        '## 4.3 节能减排',
        '（27）保障措施',
        '27、保障措施',
      ],
      [
        '## 27. 保障措施',
        '- 27. 保障措施',
        '**27. 保障措施**',
        '## 4.3 节能减排',
        '（27）保障措施',
        '27、保障措施',
      ],
    ],
    [['## 27. 2019年撤市设区', '12.5万人才完成培训。', '2019 年撤市设区。'], []],
    [['共实施一百六十项重点工程。', '共实施六十项重点工程。'], ['共实施一百六十项重点工程。']],
    [
      [
        '**编制原则**（五项）：“建设产业园区和配套设施。”（园区原则）',
        '- **园区**：2019年撤市设区。建设产业园区。',
        '**2019年撤市设区。建设产业园区。**',
        '**27. 保障措施。2019年撤市设区。**',
        '- **园区**：2019年撤市设区。',
      ],
      [
        '“建设产业园区和配套设施。”（园区原则）',
        '- **园区**：建设产业园区。',
        '建设产业园区。',
        '**27. 保障措施。**',
      ],
    ],
  ]
  for (const [head, kept] of cases) assert.deepEqual(trim(head), kept, head.join(' / '))
})
