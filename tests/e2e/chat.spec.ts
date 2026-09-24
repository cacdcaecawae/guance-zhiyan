import { expect, test } from '@playwright/test'

test.beforeEach(async ({ context }, info) => {
  await context.addCookies([
    {
      name: 'test_user',
      value: `user-${info.workerIndex}-${Date.now()}`,
      url: 'http://localhost:4173',
    },
  ])
})

test('多轮回答、思考、格式文本和刷新恢复；不执行模型 HTML', async ({ page }) => {
  await page.goto('/')
  const box = page.getByRole('textbox', { name: '研究问题' })
  await box.fill('你好')
  await box.press('Enter')
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}$/)
  const answer = page.getByRole('article', { name: '回答' })
  await expect(answer.getByRole('heading', { name: '测试回答' })).toBeVisible()
  await expect(answer.locator('strong')).toHaveText('自动化测试')
  await answer.locator('summary').click()
  await expect(answer).toContainText('检查请求内容')
  await expect(answer.locator('script')).toHaveCount(0)
  await expect(answer.locator('[href^="javascript:"]')).toHaveCount(0)
  await box.fill('继续')
  await box.press('Enter')
  await expect(answer).toHaveCount(2)
  await page.reload()
  await expect(answer).toHaveCount(2)
})

test('流式部分回答、停止、失败后重新提问', async ({ page }) => {
  await page.goto('/workspace')
  const box = page.getByRole('textbox', { name: '研究问题' })
  await box.fill('持续生成')
  await box.press('Enter')
  await expect(page.getByRole('article', { name: '回答' })).toContainText('已经生成的部分内容')
  await expect(page.getByRole('combobox', { name: '供应商' })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: '模型' })).toBeDisabled()
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByRole('status')).toContainText('已停止')
  await page.reload()
  await expect(page.getByRole('status')).toContainText('已停止')
  await box.fill('模拟失败')
  await box.press('Enter')
  await expect(page.getByRole('alert')).toContainText('失败')
  await page.getByRole('button', { name: '重新提问' }).last().click()
  await expect(page.getByRole('alert')).toHaveCount(2)
})

test('供应商和 DeepSeek 模型可切换，刷新保留，沿用同一会话历史', async ({ page }) => {
  await page.goto('/workspace')
  const provider = page.getByRole('combobox', { name: '供应商' })
  const model = page.getByRole('combobox', { name: '模型' })
  await expect(model).toHaveValue('deepseek-flash')
  await provider.selectOption('qianwen')
  await expect(model).toHaveValue('deepseek-v4.1-flash')
  await model.selectOption('deepseek-v4-pro-0813')
  await page.getByRole('textbox', { name: '研究问题' }).fill('你好')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByRole('heading', { name: '测试回答' })).toBeVisible()
  const url = page.url()
  await page.reload()
  await expect(provider).toHaveValue('qianwen')
  await expect(model).toHaveValue('deepseek-v4-pro-0813')
  await provider.selectOption('deepseek-official')
  await model.selectOption('deepseek-v4-pro')
  await page.getByRole('textbox', { name: '研究问题' }).fill('继续')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByRole('article', { name: '回答' })).toHaveCount(2)
  await expect(page).toHaveURL(url)
  await page.reload()
  await expect(provider).toHaveValue('deepseek-official')
  await expect(model).toHaveValue('deepseek-v4-pro')
})

test('真实文件工具、执行追踪和 Word 下载；其他用户不能访问', async ({ page, browser }) => {
  await page.goto('/workspace')
  await page.getByRole('textbox', { name: '研究问题' }).fill('生成报告')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.locator('summary', { hasText: '生成文件 · 已完成' })).toBeVisible()
  const link = page.getByRole('link', { name: /研究报告.docx/ })
  await expect(link).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await link.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('研究报告.docx')
  expect(await download.failure()).toBeNull()
  const other = await browser.newContext()
  try {
    await other.addCookies([{ name: 'test_user', value: 'outsider', url: 'http://localhost:4173' }])
    const response = await other.request.get(
      'http://localhost:4173' + (await link.getAttribute('href')),
    )
    expect(response.status()).toBe(404)
    const session = await other.request.get(page.url().replace('/workspace/', '/api/sessions/'))
    expect(session.status()).toBe(404)
  } finally {
    await other.close()
  }
})

test('无身份时明确拒绝；发送请求失败保留草稿', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('身份认证')
  await context.addCookies([
    { name: 'test_user', value: 'draft-test', url: 'http://localhost:4173' },
  ])
  await page.reload()
  await page.route('**/api/sessions/*/messages', (route) =>
    route.fulfill({ status: 503, json: { error: '后端尚未配置 DeepSeek 密钥。' } }),
  )
  const box = page.getByRole('textbox', { name: '研究问题' })
  await box.fill('保留问题')
  await box.press('Enter')
  await expect(page.getByRole('alert')).toContainText('尚未配置')
  await expect(box).toHaveValue('保留问题')
  const sessionsBefore = await (await page.request.get('/api/sessions')).json()
  await box.press('Enter')
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled()
  expect(await (await page.request.get('/api/sessions')).json()).toHaveLength(sessionsBefore.length)
})

test('离开工作台后，发送请求完成不会把用户带回旧页面', async ({ page }) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let markStarted = () => {}
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  await page.route('**/api/sessions/*/messages', async (route) => {
    markStarted()
    await gate
    await route.continue()
  })
  await page.goto('/workspace')
  await page.getByRole('textbox', { name: '研究问题' }).fill('你好')
  await page.getByRole('button', { name: '发送' }).click()
  await started
  await page.getByRole('link', { name: '文献库', exact: true }).click()
  const responded = page.waitForResponse((response) => response.url().endsWith('/messages'))
  release()
  await responded
  await expect(page).toHaveURL(/\/library$/)
})

for (const width of [390, 1440]) {
  for (const theme of ['浅色', '深色']) {
    test(`布局 ${width}px ${theme}、主题保留和导航抽屉`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/workspace')
      if (width === 390) await page.getByRole('button', { name: '切换侧栏' }).click()
      await page.getByRole('button', { name: theme, exact: true }).click()
      if (width === 390) await page.getByRole('button', { name: '关闭', exact: true }).click()
      await page.reload()
      if (theme === '深色') await expect(page.locator('html')).toHaveClass(/dark/)
      else await expect(page.locator('html')).not.toHaveClass(/dark/)
      const box = page.getByRole('textbox', { name: '研究问题' })
      await box.fill(`长链接 https://example.org/${'x'.repeat(200)}`)
      await box.press('Enter')
      await expect(page.getByRole('heading', { name: '测试回答' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      )
      const scroller = page.locator('[data-message-scroll]')
      expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(
        0,
      )
      await page.screenshot({ path: `test-results/workspace-${width}-${theme}.png` })
    })
  }
}
