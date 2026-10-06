import { expect, test, type Locator, type Page } from '@playwright/test'

test.beforeEach(async ({ context }, info) => {
  await context.addCookies([
    {
      name: 'test_user',
      value: `sessions-${info.workerIndex}-${Date.now()}`,
      url: 'http://localhost:4173',
    },
  ])
})

const row = (list: Locator, name: string) =>
  list.getByRole('listitem').filter({ has: list.page().getByRole('link', { name }) })

async function choose(list: Locator, name: string, action: string) {
  await row(list, name).hover()
  await row(list, name).getByRole('button', { name: '更多操作' }).click()
  await list.page().getByRole('menuitem', { name: action }).click()
}

async function ask(page: Page, question: string) {
  await page.goto('/workspace')
  const box = page.getByRole('textbox', { name: '研究问题' })
  await box.fill(question)
  await box.press('Enter')
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: '测试回答' })).toBeVisible()
}

test('研究记录可重命名、置顶和删除，刷新后保留', async ({ page }) => {
  await ask(page, '第一个问题')
  await ask(page, '第二个问题')
  const records = page.getByRole('list', { name: '研究记录' })
  const pinned = page.getByRole('list', { name: '置顶' })
  await expect(pinned).toHaveCount(0)

  // 回车保存并更新顶栏标题；Esc 放弃修改；焦点都回到这一行
  await choose(records, '第二个问题', '重命名')
  const input = page.getByRole('textbox', { name: '重命名研究记录' })
  await expect(input).toBeFocused()
  await input.fill('zheng ce')
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 13 })
  await expect(input).toBeFocused()
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: false, keyCode: 229 })
  await expect(input).toHaveValue('zheng ce')
  await expect(input).toBeFocused()
  await input.fill('政策评估')
  await input.press('Enter')
  await expect(records.getByRole('link', { name: '政策评估' })).toBeFocused()
  await expect(page).toHaveTitle('政策评估 · 管策智研')
  await choose(records, '政策评估', '重命名')
  await input.fill('不保存')
  await input.press('Escape')
  await expect(records.getByRole('link', { name: '政策评估' })).toBeFocused()
  await expect(page.getByRole('link', { name: '不保存' })).toHaveCount(0)

  // 置顶后换到“置顶”组，焦点留在它的操作按钮；重新打开会话后仍是置顶
  await choose(records, '政策评估', '置顶')
  await expect(pinned.getByRole('link', { name: '政策评估' })).toBeVisible()
  await expect(row(pinned, '政策评估').getByRole('button', { name: '更多操作' })).toBeFocused()
  await records.getByRole('link', { name: '第一个问题' }).click()
  await expect(page).toHaveTitle('第一个问题 · 管策智研')
  await pinned.getByRole('link', { name: '政策评估' }).click()
  await expect(page).toHaveTitle('政策评估 · 管策智研')
  await expect(pinned.getByRole('link', { name: '政策评估' })).toBeVisible()

  // 取消删除回到操作按钮；删除当前会话后回到工作台，焦点交给相邻的一行
  await choose(pinned, '政策评估', '删除')
  const dialog = page.getByRole('alertdialog', { name: '删除研究记录？' })
  await expect(dialog).toContainText('「政策评估」')
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(pinned, '政策评估').getByRole('button', { name: '更多操作' })).toBeFocused()
  await choose(pinned, '政策评估', '删除')
  await dialog.getByRole('button', { name: '删除' }).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/workspace$/)
  await expect(pinned).toHaveCount(0)
  await expect(records.getByRole('link', { name: '第一个问题' })).toBeFocused()

  await page.reload()
  await expect(records.getByRole('link')).toHaveText(['第一个问题'])
})

test('窄屏抽屉里重命名时按 Esc 只取消重命名，不关闭抽屉', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 })
  await ask(page, '窄屏问题')
  await page.getByRole('button', { name: '切换侧栏' }).click()
  const records = page.getByRole('list', { name: '研究记录' })
  await records.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '重命名' }).click()
  const input = page.getByRole('textbox', { name: '重命名研究记录' })
  await input.fill('未完成的候选')
  await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 27 })
  await expect(input).toBeFocused()
  await input.dispatchEvent('keydown', { key: 'Escape', isComposing: false, keyCode: 229 })
  await expect(input).toHaveValue('未完成的候选')
  await expect(input).toBeFocused()
  await input.press('Escape')
  await expect(records.getByRole('link', { name: '窄屏问题' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(records).toBeHidden()
})

test('重命名的输入法 Escape 不关闭已打开的文件预览', async ({ page }) => {
  await page.goto('/workspace')
  const box = page.getByRole('textbox', { name: '研究问题' })
  await box.fill('生成报告')
  await box.press('Enter')
  await page.getByRole('button', { name: '研究报告.docx', exact: true }).click()
  const preview = page.getByRole('complementary', { name: '文件预览' })
  await expect(preview).toBeVisible()
  const records = page.getByRole('list', { name: '研究记录' })
  await choose(records, '生成报告', '重命名')
  const input = page.getByRole('textbox', { name: '重命名研究记录' })
  await input.fill('未完成的候选')
  for (const event of [
    { key: 'Escape', isComposing: true, keyCode: 27 },
    { key: 'Escape', isComposing: false, keyCode: 229 },
  ]) {
    await input.dispatchEvent('keydown', event)
    await expect(input).toBeFocused()
    await expect(preview).toBeVisible()
  }
  await input.press('Escape')
  await expect(records.getByRole('link', { name: '生成报告' })).toBeFocused()
  await expect(preview).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
})
