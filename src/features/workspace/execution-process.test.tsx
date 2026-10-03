import { act, fireEvent, render } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { AnswerPart, AssistantMessage } from '@/types'
import { AnswerContent } from './execution-process'
import { processItems } from './tool-display'

const reasoning = (id: string, step = 1): AnswerPart => ({
  id,
  type: 'reasoning',
  step,
  text: '思考内容',
})
const reply = (id: string, step = 1): AnswerPart => ({ id, type: 'text', step, text: '阶段回复' })
const tool: AnswerPart = {
  id: 'search-1',
  type: 'tool',
  name: 'web_search',
  input: '{"query":"测试"}',
  output: '结果',
  status: 'done',
}
const running: AssistantMessage = {
  id: 'turn-1',
  role: 'assistant',
  question: '问题',
  status: 'loading',
  parts: [reasoning('live-1-0')],
}
const groups = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLDetailsElement>('details.group\\/step'))
function toggle(details: HTMLDetailsElement) {
  fireEvent.click(details.querySelector('summary')!)
  // 浏览器异步派发 toggle；这里显式送达，避免用延时等待原生 details 的通知。
  fireEvent(details, new Event('toggle'))
}
function focusGroup(group: HTMLDetailsElement) {
  toggle(group)
  const header = group.querySelector('summary')!
  act(() => header.focus())
  expect(header).toHaveFocus()
  return header
}

it.each(['loading', 'done'] as const)(
  '流提交或自动重连快照（%s）保留过程组节点、展开状态与真实键盘焦点',
  (status) => {
    const { container, rerender } = render(<AnswerContent message={running} />)
    const group = groups(container)[0]
    const header = focusGroup(group)
    // server/view.ts 的真实身份变化：实时 live-step-index → 持久 step-step-seq-index。
    const settled: AssistantMessage = {
      ...running,
      status,
      parts: [
        reasoning('step-1-8-0'),
        status === 'done' ? reply('step-1-8-1') : { ...tool, status: 'running' },
      ],
    }
    rerender(<AnswerContent message={structuredClone(settled)} />)
    expect(groups(container)[0]).toBe(group)
    expect(group).toHaveAttribute('open')
    expect(header).toHaveFocus()
    expect(container.querySelector('details.group\\/process')).toHaveAttribute('open')
  },
)

it('阶段回复进入过程并追加后续工具组时，已展开的组不重新挂载', () => {
  const { container, rerender } = render(
    <AnswerContent message={{ ...running, parts: [...running.parts, reply('live-1-1')] }} />,
  )
  const first = groups(container)[0]
  const firstHeader = focusGroup(first)
  const parts = [reasoning('step-1-8-0'), reply('step-1-8-1'), tool]
  rerender(<AnswerContent message={{ ...running, parts }} />)
  expect(groups(container)).toHaveLength(2)
  expect(groups(container)[0]).toBe(first)
  expect(first).toHaveAttribute('open')
  expect(firstHeader).toHaveFocus()

  const second = groups(container)[1]
  const secondHeader = focusGroup(second)
  rerender(<AnswerContent message={{ ...running, parts: [...parts, reasoning('live-2-0', 2)] }} />)
  rerender(
    <AnswerContent
      message={{
        ...running,
        status: 'done',
        parts: [...parts, reasoning('step-2-15-0', 2), reply('step-2-15-1', 2)],
      }}
    />,
  )
  expect(groups(container)[0]).toBe(first)
  expect(groups(container)[1]).toBe(second)
  expect(first).toHaveAttribute('open')
  expect(second).toHaveAttribute('open')
  expect(secondHeader).toHaveFocus()
})

it('同一步的失败尝试保留并追加重试流，组头身份仍保持稳定', () => {
  const { container, rerender } = render(<AnswerContent message={running} />)
  const group = groups(container)[0]
  const header = focusGroup(group)
  const attempt = reasoning('step-1-8-0')
  rerender(<AnswerContent message={{ ...running, parts: [attempt] }} />)
  rerender(<AnswerContent message={{ ...running, parts: [attempt, reasoning('live-1-0')] }} />)
  rerender(
    <AnswerContent
      message={{
        ...running,
        status: 'done',
        parts: [attempt, reasoning('step-1-10-0'), reply('step-1-10-1')],
      }}
    />,
  )
  expect(groups(container)[0]).toBe(group)
  expect(group).toHaveAttribute('open')
  expect(header).toHaveFocus()
})

it('手动收起整轮仍复位所有过程组及其思考、工具明细', () => {
  const { container } = render(
    <AnswerContent
      message={{
        ...running,
        status: 'done',
        parts: [
          reasoning('step-1-8-0'),
          reply('step-1-8-1'),
          tool,
          reasoning('step-2-15-0', 2),
          reply('step-2-15-1', 2),
        ],
      }}
    />,
  )
  const outer = container.querySelector<HTMLDetailsElement>('details.group\\/process')!
  toggle(outer)
  for (const details of outer.querySelectorAll('details')) toggle(details)
  expect(Array.from(outer.querySelectorAll('details')).every((item) => item.open)).toBe(true)
  const before = groups(container)
  toggle(outer)
  toggle(outer)
  expect(groups(container)).toHaveLength(2)
  expect(groups(container)[0]).not.toBe(before[0])
  expect(Array.from(outer.querySelectorAll('details')).every((item) => !item.open)).toBe(true)
})

it('组键跨实时和持久片段稳定，同一步被阶段回复切开的组仍有不同键', () => {
  const before = processItems(
    [reasoning('live-1-0'), reply('live-1-1'), reasoning('live-1-2')],
    false,
  ).filter((item) => item.kind === 'group')
  const after = processItems(
    [reasoning('step-1-8-0'), reply('step-1-8-1'), reasoning('step-1-8-2')],
    true,
  ).filter((item) => item.kind === 'group')
  expect(after.map((item) => item.key)).toEqual(before.map((item) => item.key))
  expect(new Set(after.map((item) => item.key)).size).toBe(2)
})
