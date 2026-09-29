import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/types/index.ts'
import { checkCitations } from './view.ts'

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
            `外部网址[原文](https://evil.example${path(returned)})`,
            `协议相对[原文](//evil.example${path(returned)})`,
            `查询参数[原文](https://evil.example/?next=${path(returned)})`,
            `附加参数[原文](${path(returned)}?x=1)`,
            `正文提及 ${path(returned)} 不是链接`,
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
  assert.equal(
    all.split(path(returned)).length - 1,
    2,
    'a returned passage stays only as a whole link destination',
  )
  assert.equal(texts[0], '先写引用[原文]()', 'a citation before any search result is not kept')
  assert.ok(texts[1].startsWith(`有效[原文](${path(returned)})`))
  assert.equal(texts.at(-1), `上一轮返回的仍可引用[原文](${path(returned)})`)
  const once = structuredClone(messages)
  checkCitations(messages)
  assert.deepEqual(messages, once, 'checking again changes nothing')
})
