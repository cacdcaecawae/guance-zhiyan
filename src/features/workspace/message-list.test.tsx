import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
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
