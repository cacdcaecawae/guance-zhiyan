import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from './composer'

describe('Composer', () => {
  it('请求等待期间输入的新草稿不会被成功确认清空', async () => {
    let finish = (_value: boolean) => {}
    const response = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    render(<Composer onSubmit={() => response} />)
    const box = screen.getByRole('textbox', { name: '研究问题' })
    await userEvent.type(box, '第一条')
    await userEvent.keyboard('{Enter}')
    await userEvent.clear(box)
    await userEvent.type(box, '下一条草稿')
    await act(async () => {
      finish(true)
      await response
    })
    expect(box).toHaveValue('下一条草稿')
  })
  it('空白内容不可提交', async () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} />)
    const send = screen.getByRole('button', { name: '发送' })
    expect(send).toHaveAttribute('aria-disabled', 'true')

    await userEvent.type(screen.getByRole('textbox', { name: '研究问题' }), '   ')
    expect(send).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Enter 提交去掉首尾空白并清空输入', async () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} />)
    const box = screen.getByRole('textbox', { name: '研究问题' })
    await userEvent.type(box, '  示例问题  ')
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('示例问题')
    expect(box).toHaveValue('')
  })

  it('Shift+Enter 换行而不提交', async () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} />)
    const box = screen.getByRole('textbox', { name: '研究问题' })
    await userEvent.type(box, '第一行')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    await userEvent.type(box, '第二行')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(box).toHaveValue('第一行\n第二行')
  })

  it('输入法确认用的 Enter（keyCode 229）不提交', () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} />)
    const box = screen.getByRole('textbox', { name: '研究问题' })
    fireEvent.change(box, { target: { value: 'xie tong' } })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('xie tong')
  })

  it('加载中禁止再次提交', async () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} busy />)
    await userEvent.type(screen.getByRole('textbox', { name: '研究问题' }), '问题')
    expect(screen.getByRole('button', { name: '发送' })).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
