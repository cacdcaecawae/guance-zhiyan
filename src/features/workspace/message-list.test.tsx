import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@/types'
import { MessageList } from './message-list'

const base: AssistantMessage = {
  id: 'a1',
  role: 'assistant',
  status: 'done',
  question: 'q',
  text: '',
  citations: [],
}

describe('MessageList', () => {
  it('回答中的 [n] 角标渲染为引用按钮，点击返回对应引用', async () => {
    const onOpenCitation = vi.fn()
    const message: AssistantMessage = {
      ...base,
      text: '前文[1]中间[2]后文',
      citations: [
        { id: 'c1', marker: 1, passageId: 'p-x' },
        { id: 'c2', marker: 2, passageId: 'p-y' },
      ],
    }
    render(
      <MessageList
        messages={[message]}
        activePassageId={null}
        onOpenCitation={onOpenCitation}
        onRetry={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: '查看引用 2' }))
    expect(onOpenCitation).toHaveBeenCalledExactlyOnceWith(message.citations[1])
    expect(screen.getByRole('article', { name: '回答' })).toHaveTextContent('前文1中间2后文')
  })

  it('失败状态显示错误与重试按钮', async () => {
    const onRetry = vi.fn()
    const failed: AssistantMessage = { ...base, status: 'error', error: '模拟失败' }
    render(
      <MessageList
        messages={[failed]}
        activePassageId={null}
        onOpenCitation={() => {}}
        onRetry={onRetry}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('模拟失败')
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(failed)
  })
})
