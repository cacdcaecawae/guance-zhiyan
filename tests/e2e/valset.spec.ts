import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import ExcelJS from 'exceljs'

test.beforeEach(async ({ context }, info) => {
  await context.addCookies([
    {
      name: 'test_user',
      value: `valset-${info.workerIndex}-${Date.now()}`,
      url: 'http://localhost:4173',
    },
  ])
})

async function xlsx(rows: unknown[][]) {
  const book = new ExcelJS.Workbook()
  book.addWorksheet('Sheet1').addRows(rows)
  return Buffer.from(await book.xlsx.writeBuffer())
}

test('上传验证集逐题作答，查看会话并导出模板格式的结果', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: '验证集测试' }).click()
  await expect(page).toHaveURL(/\/valset$/)

  const [template] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: '下载模板' }).click(),
  ])
  expect(template.suggestedFilename()).toBe('验证集上传模板.xlsx')

  const picker = page.getByLabel('选择验证集文件')
  const progress = page.getByRole('status').filter({ hasText: '已完成' })
  await picker.setInputFiles({
    name: '验证集.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('问题'),
  })
  await expect(page.getByRole('alert')).toContainText('.xlsx')
  await expect(page.getByRole('button', { name: '开始测试' })).toBeDisabled()

  // 一次选多个：非 xlsx 不加入并列出文件名，新加入的最后一个默认选中
  const sheet = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const spare = await xlsx([
    ['问题', '预期答案'],
    ['备用', '无'],
  ])
  await picker.setInputFiles([
    { name: '备用.xlsx', mimeType: sheet, buffer: spare },
    {
      name: '样例验证集.xlsx',
      mimeType: sheet,
      buffer: await xlsx([
        ['问题', '预期答案'],
        ['你好', '测试回答'],
        ['模拟失败', '无'],
      ]),
    },
    { name: '说明.txt', mimeType: 'text/plain', buffer: Buffer.from('说明') },
  ])
  await expect(page.getByRole('alert')).toContainText('说明.txt')
  const listed = page.getByRole('list', { name: '待测试的文件' }).getByRole('listitem')
  await expect(listed).toHaveCount(2)
  await expect(page.getByRole('radio', { name: /样例验证集\.xlsx/ })).toBeChecked()

  // 移除一行；选中的被移除时落到第一个
  await picker.setInputFiles({ name: '多余.xlsx', mimeType: sheet, buffer: spare })
  await expect(listed).toHaveCount(3)
  await expect(page.getByRole('radio', { name: /多余\.xlsx/ })).toBeChecked()
  await page.getByRole('button', { name: '移除 多余.xlsx' }).click()
  await expect(listed).toHaveCount(2)
  await expect(page.getByRole('radio', { name: /备用\.xlsx/ })).toBeChecked()

  // 选中第二个开始：该行移出列表，剩下的仍在并被选中
  await page.getByRole('radio', { name: /样例验证集\.xlsx/ }).check()
  await page.getByRole('button', { name: '开始测试' }).click()
  await expect(page).toHaveURL(/\/valset\?job=[0-9a-f-]{36}$/)
  await expect(listed).toHaveCount(1)
  await expect(page.getByRole('radio', { name: /备用\.xlsx/ })).toBeChecked()
  await expect(progress).toHaveText('已完成 2 / 2 题 · 正常 1 · 失败 1')
  const rows = page.getByRole('row')
  await expect(rows.nth(1)).toContainText('正常')
  await expect(rows.nth(2)).toContainText('失败')

  // 刷新后任务仍在
  await page.reload()
  await expect(progress).toHaveText('已完成 2 / 2 题 · 正常 1 · 失败 1')

  const [result] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: '导出结果 Excel' }).click(),
  ])
  expect(result.suggestedFilename()).toBe('验证集结果-样例验证集.xlsx')
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(Uint8Array.from(await readFile(await result.path())).buffer)
  const values = book.worksheets[0]
    .getSheetValues()
    .slice(1)
    .map((row) => (row as unknown[]).slice(1))
  expect(values[0]).toEqual(['问题', '预期答案', '智能体实际回复', '耗时(秒)', '状态'])
  expect(values[1][0]).toBe('你好')
  expect(String(values[1][2])).toMatch(/^测试回答\n这是自动化测试结果。\n第一项\n第二项\n来源/)
  expect(String(values[1][2])).not.toMatch(/\*\*|##|\]\(|https?:/)
  expect(typeof values[1][3]).toBe('number')
  expect(values[2].slice(2).at(-1)).toBe('失败')
  expect(values[2][2]).toBe('（空）')

  // 每题会话可查看完整回答，但不列入研究记录
  await page.getByRole('link', { name: '查看第 1 题的会话' }).click()
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: '测试回答' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主导航' })).not.toContainText('验证集 ·')
  const session = page.url()

  // 删除任务：确认框默认聚焦“取消”；删除后任务与各题会话都不再存在，焦点交给上传区
  await page.goBack()
  await page.getByRole('button', { name: '删除任务' }).click()
  const dialog = page.getByRole('alertdialog', { name: '删除验证集任务？' })
  await expect(dialog).toContainText('2 个题目会话')
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/valset$/)
  await expect(progress).toHaveCount(0)
  await expect(picker).toBeFocused()
  await page.goto(session)
  await expect(page.getByRole('alert')).toContainText('没有找到会话')
})
