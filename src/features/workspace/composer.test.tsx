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
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('示例问题', [])
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
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('xie tong', [])
  })

  it('加载中禁止再次提交', async () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} busy />)
    await userEvent.type(screen.getByRole('textbox', { name: '研究问题' }), '问题')
    expect(screen.getByRole('button', { name: '发送' })).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('选择或粘贴图片后显示缩略图，只有图片也可发送，成功后清空', async () => {
    const onSubmit = vi.fn()
    render(<Composer onSubmit={onSubmit} />)
    const chart = new File(['png'], '图表.png', { type: 'image/png' })
    const form = new File(['jpg'], '表格.jpg', { type: 'image/jpeg' })
    await userEvent.upload(screen.getByLabelText('选择图片'), chart)
    const box = screen.getByRole('textbox', { name: '研究问题' })
    // 剪贴板带文字时（如从 Word 复制）不取附带的截图
    fireEvent.paste(box, { clipboardData: { files: [form], getData: () => '一段文字' } })
    expect(screen.getAllByRole('img')).toHaveLength(1)
    fireEvent.paste(box, { clipboardData: { files: [form], getData: () => '' } })
    expect(screen.getByRole('img', { name: '表格.jpg' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '移除图片 表格.jpg' }))
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('', [chart])
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('发送成功后只移除已发送的图片，等待期间新加的图片保留', async () => {
    let finish = (_value: boolean) => {}
    const response = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    render(<Composer onSubmit={() => response} />)
    const picker = screen.getByLabelText('选择图片')
    await userEvent.upload(picker, new File(['a'], '已发送.png', { type: 'image/png' }))
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    await userEvent.upload(picker, new File(['b'], '新加.png', { type: 'image/png' }))
    await act(async () => {
      finish(true)
      await response
    })
    expect(screen.queryByRole('img', { name: '已发送.png' })).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: '新加.png' })).toBeInTheDocument()
  })

  it('不支持的文件不加入并说明原因', () => {
    render(<Composer onSubmit={vi.fn()} />)
    fireEvent.drop(screen.getByRole('form', { name: '提问' }), {
      dataTransfer: { files: [new File(['%PDF'], '简历.pdf', { type: 'application/pdf' })] },
    })
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('PDF 等文件敬请期待')
    expect(screen.getByRole('button', { name: '发送' })).toHaveAttribute('aria-disabled', 'true')
  })
})
