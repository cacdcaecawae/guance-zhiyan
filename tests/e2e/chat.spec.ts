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
  // 完成后过程折起，逐层展开：整轮 → 过程组 → 思考
  await answer.locator('summary', { hasText: /^已完成，用时 \d+秒$/ }).click()
  await answer.locator('summary', { hasText: '已完成分析' }).click()
  await answer.locator('summary', { hasText: '思考' }).click()
  await expect(answer).toContainText('检查请求内容')
  await expect(answer.locator('script')).toHaveCount(0)
  await expect(answer.locator('[href^="javascript:"]')).toHaveCount(0)
  await box.fill('继续')
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await box.press('Enter')
  await expect(answer).toHaveCount(2)
  await page.reload()
  await expect(answer).toHaveCount(2)
})

test('流式部分回答、停止、失败后原位重新生成', async ({ page }) => {
  await page.goto('/workspace')
  const box = page.getByRole('textbox', { name: '研究问题' })
  await box.fill('持续生成')
  await box.press('Enter')
  await expect(page.getByRole('article', { name: '回答' })).toContainText('已经生成的部分内容')
  await expect(page.getByRole('combobox', { name: '模型' })).toBeDisabled()
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByRole('status')).toContainText('已停止')
  await page.reload()
  await expect(page.getByRole('status')).toContainText('已停止')
  await box.fill('模拟失败')
  await box.press('Enter')
  await expect(page.getByRole('alert')).toContainText('失败')
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/retry') && response.status() === 202,
    ),
    page.getByRole('button', { name: '重新生成' }).click(),
  ])
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('article', { name: '回答' })).toHaveCount(2)
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole('article', { name: '回答' })).toHaveCount(2)
})

test('同一列表按平台切换 DeepSeek 模型，刷新保留，沿用同一会话历史', async ({ page }) => {
  await page.goto('/workspace')
  const model = page.getByRole('combobox', { name: '模型' })
  // 两个平台有同名模型，选项名只含模型名，需按平台分组定位
  const pick = async (platform: string, name: string) => {
    await model.click()
    await page
      .getByRole('group', { name: platform })
      .getByRole('option', { name, exact: true })
      .click()
  }
  await expect(model).toContainText('DeepSeek V4.1 Flash · DeepSeek 官方')
  await pick('千问 AI 平台', 'DeepSeek V4 Pro（0813）')
  await expect(model).toContainText('DeepSeek V4 Pro（0813） · 千问 AI 平台')
  await page.getByRole('textbox', { name: '研究问题' }).fill('你好')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByRole('heading', { name: '测试回答' })).toBeVisible()
  const url = page.url()
  await page.reload()
  await expect(model).toContainText('DeepSeek V4 Pro（0813） · 千问 AI 平台')
  await pick('DeepSeek 官方', 'DeepSeek V4 Pro')
  await page.getByRole('textbox', { name: '研究问题' }).fill('继续')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByRole('article', { name: '回答' })).toHaveCount(2)
  await expect(page).toHaveURL(url)
  await page.reload()
  await expect(model).toContainText('DeepSeek V4 Pro · DeepSeek 官方')
})

test('真实文件工具、执行追踪和 Word 下载；其他用户不能访问', async ({ page, browser }) => {
  await page.goto('/workspace')
  await page.getByRole('textbox', { name: '研究问题' }).fill('生成报告')
  await page.getByRole('button', { name: '发送' }).click()
  const answer = page.getByRole('article', { name: '回答' })
  const process = answer.locator('summary', { hasText: /已完成，用时/ })
  await expect(process).toBeVisible()
  const reasoning = answer.locator('summary', { hasText: '思考' })
  await expect(reasoning).toHaveCount(2)
  // 完成后过程折起，只留最终回答；阶段回复也随过程收起
  await expect(answer.getByText('文件已生成，请从下方文件卡片下载。')).toBeVisible()
  await expect(answer.getByText('先生成报告。')).not.toBeVisible()
  await process.click()
  // 展开后是过程组头与阶段回复：阶段回复把思考与工具切成两组，组内明细仍收起
  await expect(answer.locator('summary')).toHaveText([
    /已完成，用时/,
    /已完成分析/,
    /思考/,
    /已生成文件/,
    /生成文件.*已完成/,
    /思考/,
  ])
  await expect(answer.getByText('先生成报告。')).toBeVisible()
  await expect(reasoning.first()).not.toBeVisible()
  await page.reload()
  await process.click()
  for (const name of ['已完成分析', '已生成文件'])
    await answer.locator('summary', { hasText: name }).click()
  await expect(reasoning).toHaveCount(2)
  for (const item of await reasoning.all()) await item.click()
  await expect(answer.getByText('测试适配器：检查请求内容。', { exact: true })).toHaveCount(2)
  const link = page.getByRole('link', { name: /研究报告.docx/ })
  await expect(link).toBeVisible()
  await page.getByRole('button', { name: '研究报告.docx' }).click()
  await expect(page.getByRole('complementary', { name: '文件预览' })).toContainText(
    'DOCX 文件暂不支持在线预览',
  )
  const downloadPromise = page.waitForEvent('download')
  await link.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('研究报告.docx')
  expect(await download.failure()).toBeNull()
  await page.getByRole('tab', { name: '轨迹', exact: true }).click()
  const trace = page.getByRole('tabpanel', { name: '轨迹', exact: true })
  await expect(trace.getByLabel('执行时间分布')).toBeVisible()
  await expect(trace.locator('summary', { hasText: /第 1 轮/ })).toBeVisible()
  const tool = trace.locator('summary', { hasText: /工具.*生成文件/ })
  await tool.click()
  await expect(trace.getByText('调用参数', { exact: true })).toBeVisible()
  await trace.getByRole('button', { name: '调用', exact: true }).click()
  await expect(tool).not.toBeVisible()
  await trace.getByRole('button', { name: '调用', exact: true }).click()
  await expect(tool).toBeVisible()
  await trace.getByRole('button', { name: '全部收起', exact: true }).click()
  await expect(tool).not.toBeVisible()
  await trace.getByRole('button', { name: '全部展开', exact: true }).click()
  await trace.getByRole('button', { name: '时长', exact: true }).click()
  await expect(trace.getByText('事件顺序', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '轨迹', exact: true }).press('ArrowLeft')
  await expect(page.getByRole('tab', { name: '对话', exact: true })).toBeFocused()
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
      await box.fill('生成报告')
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
      await box.press('Enter')
      // 第二个回答完成后过程折起，展开再截图
      const report = page.getByRole('article', { name: '回答' }).nth(1)
      await report.locator('summary', { hasText: /已完成，用时/ }).click()
      await report.locator('summary', { hasText: '已生成文件' }).click()
      await expect(report.locator('summary', { hasText: /生成文件.*已完成/ })).toBeVisible()
      await page.screenshot({ path: `test-results/process-${width}-${theme}.png` })
      await page.getByRole('tab', { name: '轨迹', exact: true }).click()
      await expect(page.getByLabel('执行时间分布')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      )
      await page.screenshot({ path: `test-results/trace-${width}-${theme}.png` })
    })
  }
}

test('上传图片随问题发送，刷新及原位重新生成保留同一组原图', async ({ page }) => {
  await page.goto('/workspace')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  // 1×20 的长图，模拟手机长截图
  const tall = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAUCAAAAABpZQh9AAAADUlEQVR42mNoYCAKAgDIKAoBW2+cOQAAAABJRU5ErkJggg==',
    'base64',
  )
  await page.getByLabel('选择图片').setInputFiles([
    { name: '表格.png', mimeType: 'image/png', buffer: png },
    { name: '长图.png', mimeType: 'image/png', buffer: tall },
  ])
  const form = page.getByRole('form', { name: '提问' })
  await expect(form.getByRole('img', { name: '表格.png' })).toBeVisible()
  const box = page.getByRole('textbox', { name: '研究问题' })
  await box.fill('模拟失败')
  await box.press('Enter')
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}$/)
  await expect(form.getByRole('img')).toHaveCount(0)
  const attached = page.getByRole('list', { name: '问题附图' })
  await expect(attached.getByRole('img', { name: '表格.png' })).toHaveJSProperty('naturalWidth', 1)
  // 1×1 的图也按固定高度显示，不会只剩一个像素；长图保留最小宽度，不会缩成一条细线
  const shown = await attached.getByRole('img', { name: '表格.png' }).boundingBox()
  expect(shown!.height).toBeCloseTo(160, 0)
  const long = await attached.getByRole('img', { name: '长图.png' }).boundingBox()
  expect(long!.height).toBeCloseTo(160, 0)
  expect(long!.width).toBeCloseTo(96, 0)
  await expect(page.getByRole('alert')).toContainText('失败')
  await page.reload()
  await expect(attached.getByRole('img', { name: '表格.png' })).toHaveJSProperty('naturalWidth', 1)
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/retry') && response.status() === 202,
    ),
    page.getByRole('button', { name: '重新生成' }).click(),
  ])
  await expect(attached).toHaveCount(1)
  await expect(page.getByRole('article', { name: '回答' })).toHaveCount(1)
  await page.reload()
  await expect(attached).toHaveCount(1)
  await expect(attached.last().getByRole('img', { name: '表格.png' })).toHaveJSProperty(
    'naturalWidth',
    1,
  )
})

test('下载保留含单引号、中文、空格及括号的成果文件名', async ({ page }) => {
  await page.goto('/workspace')
  await page.getByRole('textbox', { name: '研究问题' }).fill('生成报告，文件名带单引号')
  await page.getByRole('button', { name: '发送' }).click()
  const name = "O'Reilly 研究(2026).docx"
  const link = page.getByRole('link', { name: `下载 ${name}`, exact: true })
  await expect(link).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await link.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(name)
  expect(await download.failure()).toBeNull()
})

test('重新生成在原问题下成功，刷新后仍只有一条回答且不再提供失败重试', async ({ page }) => {
  await page.goto('/workspace')
  const box = page.getByRole('textbox', { name: '研究问题' })
  await box.fill('原位重试测试')
  await box.press('Enter')
  await expect(page.getByRole('alert')).toContainText('失败')
  const button = page.getByRole('button', { name: '重新生成' })
  await button.click()
  await expect(page.getByRole('article', { name: '回答' })).toContainText('原位重新生成已完成')
  await expect(page.getByRole('article', { name: '回答' })).toHaveCount(1)
  await expect(button).toHaveCount(0)
  // 只数对话气泡；标题、侧栏及保留的原始轨迹也会包含这段问题文字。
  const question = page
    .getByRole('tabpanel', { name: '对话', exact: true })
    .getByText('原位重试测试')
  await expect(question).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole('article', { name: '回答' })).toContainText('原位重新生成已完成')
  await expect(page.getByRole('article', { name: '回答' })).toHaveCount(1)
  await expect(button).toHaveCount(0)
  await expect(question).toHaveCount(1)
})
