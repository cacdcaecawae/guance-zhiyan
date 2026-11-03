import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

it('触发器只显示模型名，平台名在读屏名称里，并标出未配置密钥的平台', () => {
  const { rerender } = render(
    <ModelPicker catalog={catalog} selection={catalog.defaultSelection} onChange={() => {}} />,
  )
  const trigger = screen.getByRole('combobox', {
    name: '模型：DeepSeek V4.1 Flash · DeepSeek 官方',
  })
  expect(trigger).toHaveTextContent(/^DeepSeek V4\.1 Flash$/)
  rerender(
    <ModelPicker
      catalog={catalog}
      selection={{ provider: 'qianwen', model: 'deepseek-v4.1-flash' }}
      disabled
      onChange={() => {}}
    />,
  )
  expect(trigger).toHaveTextContent(/^DeepSeek V4\.1 Flash（未配置密钥）$/)
  expect(trigger).toHaveAccessibleName('模型：DeepSeek V4.1 Flash · 千问 AI 平台（未配置密钥）')
  expect(trigger).toBeDisabled()
})

it('多个平台时按平台分组，只有一个平台时不显示分组标题', async () => {
  const user = userEvent.setup()
  const { unmount } = render(
    <ModelPicker catalog={catalog} selection={catalog.defaultSelection} onChange={() => {}} />,
  )
  // jsdom 没有指针捕获，用键盘打开
  screen.getByRole('combobox').focus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('group', { name: /千问 AI 平台/ })).toBeInTheDocument()
  unmount()
  const single = { ...catalog, providers: catalog.providers.slice(0, 1) }
  render(<ModelPicker catalog={single} selection={single.defaultSelection} onChange={() => {}} />)
  screen.getByRole('combobox').focus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('option', { name: 'DeepSeek V4.1 Flash' })).toBeInTheDocument()
  expect(screen.queryByText('DeepSeek 官方')).toBeNull()
})
