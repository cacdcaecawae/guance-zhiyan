import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
  const { rerender } = render(
    <MessageList sessionId="s" messages={[message]} busy={false} onRetry={() => {}} />,
  )
  expect(screen.getByText('本次未返回正文。')).toBeInTheDocument()
  rerender(
    <MessageList
      sessionId="s"
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
  render(<MessageList sessionId="s" messages={[answer]} busy={false} onRetry={() => {}} />)
  const copy = screen.getByRole('button', { name: '复制回答' })
  fireEvent.click(copy)
  expect(writeText).toHaveBeenCalledExactlyOnceWith('文件已生成')
  expect(await screen.findByText('已复制')).toBeInTheDocument()
  writeText.mockRejectedValueOnce(new Error('denied'))
  fireEvent.click(copy)
  expect(await screen.findByText('复制失败')).toBeInTheDocument()
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  fireEvent.click(copy)
  expect(screen.getByText('复制失败')).toBeInTheDocument()
})

it('执行过程标题写用时，完成后折起；最后一步的思考也收在过程里，正文留在外面', () => {
  const message: AssistantMessage = {
    ...answer,
    startedAt: 1_000,
    endedAt: 66_000,
    parts: [
      { id: 'r1', type: 'reasoning', step: 1, text: '先查' },
      answer.parts[1],
      { id: 'r2', type: 'reasoning', step: 2, text: '再想' },
      answer.parts[2],
    ],
  }
  render(<MessageList sessionId="s" messages={[message]} busy={false} onRetry={() => {}} />)
  const process = screen.getByText('已完成，用时 1分05秒').closest('details')!
  expect(process).not.toHaveAttribute('open')
  expect(within(process).getAllByText('思考过程')).toHaveLength(2)
  expect(process).not.toContainElement(screen.getByText('文件已生成'))
  expect(screen.queryByText(/次|失败/)).not.toBeInTheDocument()
})

it('没有过程内容的回答也写用时，只是不能展开', () => {
  const plain: AssistantMessage = {
    ...answer,
    startedAt: 0,
    endedAt: 3_400,
    parts: [answer.parts[2]],
  }
  render(<MessageList sessionId="s" messages={[plain]} busy={false} onRetry={() => {}} />)
  const label = screen.getByText('已完成，用时 3秒')
  expect(label.closest('details')).toBeNull()
})

it('进行中每秒更新用时并保持展开；停止与失败写明状态与用时', () => {
  vi.useFakeTimers({ now: 13_500 })
  const running: AssistantMessage = { ...answer, status: 'loading', startedAt: 1_000 }
  const { rerender } = render(
    <MessageList sessionId="s" messages={[running]} busy onRetry={() => {}} />,
  )
  const label = screen.getByText('进行中，用时 12秒')
  expect(label.closest('details')).toHaveAttribute('open')
  act(() => vi.advanceTimersByTime(1000))
  expect(label).toHaveTextContent('进行中，用时 13秒')
  vi.useRealTimers()
  for (const [status, text] of [
    ['stopped', '已停止，用时 4秒'],
    ['error', '处理失败，用时 4秒'],
  ] as const) {
    rerender(
      <MessageList
        sessionId="s"
        messages={[{ ...running, status, endedAt: 5_000 }]}
        busy={false}
        onRetry={() => {}}
      />,
    )
    expect(label).toHaveTextContent(text)
    expect(label.closest('details')).toHaveAttribute('open')
  }
})

it('离开底部时出现“回到底部”，点击滚到容器底部', () => {
  render(
    <div data-message-scroll>
      <MessageList sessionId="s" messages={[answer]} busy={false} onRetry={() => {}} />
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

it('停止时中断的工具不计为失败；复制保留开头缩进', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const message: AssistantMessage = {
    id: 'answer',
    role: 'assistant',
    question: 'q',
    status: 'stopped',
    parts: [
      { id: 'text', type: 'text', step: 1, text: '先搜索。' },
      {
        id: 'tool',
        type: 'tool',
        name: 'web_search',
        input: '{}',
        output: '工具执行已中断。',
        status: 'stopped',
      },
      { id: 'final', type: 'text', step: 2, text: '\n    缩进代码\n' },
    ],
  }
  render(<MessageList sessionId="s" messages={[message]} busy={false} onRetry={() => {}} />)
  expect(screen.queryByText(/次失败/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '复制回答' }))
  expect(writeText).toHaveBeenCalledWith('    缩进代码')
})

it('问题附图显示在气泡上方，点开查看本会话原图；只有图片时不画空气泡', () => {
  render(
    <MessageList
      sessionId="s"
      messages={[
        {
          id: 'q',
          role: 'user',
          text: '',
          images: [{ id: 'sha256:abc', name: '表格.png', width: 800, height: 300 }],
        },
      ]}
      busy={false}
      onRetry={() => {}}
    />,
  )
  const image = screen.getByRole('img', { name: '表格.png' })
  expect(image).toHaveAttribute('src', '/api/sessions/s/images/sha256%3Aabc')
  expect(screen.getByRole('link')).toHaveAttribute('href', image.getAttribute('src'))
  expect(screen.queryByText('问题：')).not.toBeInTheDocument()
})
