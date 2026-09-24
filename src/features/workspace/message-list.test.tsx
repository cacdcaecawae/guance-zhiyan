import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MessageList } from './message-list'
import type { AssistantMessage } from '@/types'

it('已完成的思考或工具过程没有最终正文时明确提示', () => {
  const message: AssistantMessage = {
    id: 'answer',
    role: 'assistant',
    question: 'report',
    status: 'done',
    parts: [
      { id: 'reasoning', type: 'reasoning', step: 1, text: '思考' },
      { id: 'progress', type: 'text', step: 1, text: '正在生成文件' },
      { id: 'tool', type: 'tool', name: 'create_file', input: '{}', output: '{}', status: 'done' },
    ],
  }
  const { rerender } = render(<MessageList messages={[message]} busy={false} onRetry={() => {}} />)
  expect(screen.getByText('本次未返回正文。')).toBeInTheDocument()
  rerender(
    <MessageList
      messages={[
        {
          ...message,
          parts: [...message.parts, { id: 'final', type: 'text', step: 2, text: '文件已生成' }],
        },
      ]}
      busy={false}
      onRetry={() => {}}
    />,
  )
  expect(screen.queryByText('本次未返回正文。')).not.toBeInTheDocument()
})

const answer: AssistantMessage = {
  id: 'answer',
  role: 'assistant',
  question: 'report',
  status: 'done',
  parts: [
    { id: 'progress', type: 'text', step: 1, text: '正在生成文件' },
    { id: 'tool', type: 'tool', name: 'create_file', input: '{}', output: '{}', status: 'done' },
    { id: 'final', type: 'text', step: 2, text: '文件已生成' },
  ],
}

it('复制只写入最终回答；剪贴板失败或不可用时明确提示', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  render(<MessageList messages={[answer]} busy={false} onRetry={() => {}} />)
  const copy = screen.getByRole('button', { name: '复制回答' })
  fireEvent.click(copy)
  expect(writeText).toHaveBeenCalledExactlyOnceWith('文件已生成')
  expect(await screen.findByText('已复制')).toBeInTheDocument()
  writeText.mockRejectedValueOnce(new Error('denied'))
  fireEvent.click(copy)
  expect(await screen.findByText('复制失败，请手动选择文本')).toBeInTheDocument()
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  fireEvent.click(copy)
  expect(screen.getByText('复制失败，请手动选择文本')).toBeInTheDocument()
})

it('执行过程汇总只列非零计数，全为零时写“执行过程”', () => {
  const tool = { ...answer, parts: [answer.parts[1], answer.parts[2]] }
  const { rerender } = render(<MessageList messages={[tool]} busy={false} onRetry={() => {}} />)
  expect(screen.getByText('1 次工具调用')).toBeInTheDocument()
  const reasoning: AssistantMessage = {
    ...answer,
    status: 'error',
    parts: [{ id: 'r', type: 'reasoning', step: 1, text: '思考' }],
  }
  rerender(<MessageList messages={[reasoning]} busy={false} onRetry={() => {}} />)
  expect(screen.getByText('执行过程')).toBeInTheDocument()
})

it('离开底部时出现“回到底部”，点击滚到容器底部', () => {
  render(
    <div data-message-scroll>
      <MessageList messages={[answer]} busy={false} onRetry={() => {}} />
    </div>,
  )
  const scroller = document.querySelector<HTMLElement>('[data-message-scroll]')!
  Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
  scroller.scrollTo = vi.fn()
  expect(screen.queryByRole('button', { name: '回到底部' })).not.toBeInTheDocument()
  fireEvent.scroll(scroller)
  fireEvent.click(screen.getByRole('button', { name: '回到底部' }))
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1000 })
})
