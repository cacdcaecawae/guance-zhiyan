import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ModelPicker } from './model-picker'

const catalog = {
  providers: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek 官方',
      configured: true,
      models: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }],
    },
    {
      id: 'qianwen',
      name: '千问 AI 平台',
      configured: false,
      models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
    },
  ],
  defaultSelection: { provider: 'deepseek-official', model: 'deepseek-flash' },
}

it('触发器显示模型名与平台名，并标出未配置密钥的平台', () => {
  const { rerender } = render(
    <ModelPicker catalog={catalog} selection={catalog.defaultSelection} onChange={() => {}} />,
  )
  const trigger = screen.getByRole('combobox', { name: '模型' })
  expect(trigger).toHaveTextContent(/^DeepSeek V4\.1 Flash · DeepSeek 官方$/)
  rerender(
    <ModelPicker
      catalog={catalog}
      selection={{ provider: 'qianwen', model: 'deepseek-v4.1-flash' }}
      disabled
      onChange={() => {}}
    />,
  )
  expect(trigger).toHaveTextContent('DeepSeek V4.1 Flash · 千问 AI 平台（未配置密钥）')
  expect(trigger).toBeDisabled()
})
