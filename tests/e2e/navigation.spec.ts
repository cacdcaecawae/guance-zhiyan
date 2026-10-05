import { expect, test, type Page, type Route } from '@playwright/test'

const png = {
  name: '待发送.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
}

// Keep the real server and services; release the HTTP request at the relevant UI transition.
async function holdPost(page: Page, path: string) {
  const started = Promise.withResolvers<Route>()
  let captured = false
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST' || captured) return route.fallback()
    captured = true
    // Removing the last route handler releases an intercepted request in Chromium.
    // Keep this one registered; later requests fall through while this route is held.
    started.resolve(route)
  }
  await page.route(path, handler)
  return { started: started.promise }
}

test.beforeEach(async ({ context }, info) => {
  await context.addCookies([
    {
      name: 'test_user',
      value: `navigation-${info.workerIndex}-${Date.now()}`,
      url: 'http://localhost:4173',
    },
  ])
})

test('首次发送保留等待期间的新草稿和图片；后退、前进和切换会话重置草稿', async ({ page }) => {
  const pending = await holdPost(page, '**/api/sessions/*/messages')
  await page.goto('/workspace')
  const box = page.getByRole('textbox', { name: '研究问题' })
  const form = page.getByRole('form', { name: '提问' })
  await box.fill('第一条')
  await page.getByLabel('选择图片').setInputFiles({ ...png, name: '已发送.png' })
  await box.press('Enter')
  const request = await pending.started
  await box.fill('下一条草稿')
  await page.getByLabel('选择图片').setInputFiles(png)
  await request.continue()
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: '测试回答' })).toBeVisible()
  const firstSession = page.url()
  await expect(box).toHaveValue('下一条草稿')
  await expect(form.getByRole('img', { name: '待发送.png' })).toBeVisible()
  await expect(form.getByRole('img', { name: '已发送.png' })).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/workspace$/)
  await expect(box).toHaveValue('')
  await expect(form.getByRole('img')).toHaveCount(0)
  await box.fill('前进前的草稿')
  await page.goForward()
  await expect(page).toHaveURL(firstSession)
  await expect(box).toHaveValue('')
  await box.fill('切换前的草稿')
  await page.getByLabel('选择图片').setInputFiles(png)
  await page.getByRole('link', { name: '新建研究' }).click()
  await expect(page).toHaveURL(/\/workspace$/)
  await expect(box).toHaveValue('')
  await expect(box).toBeFocused()
  await expect(form.getByRole('img')).toHaveCount(0)
  await box.fill('另一个会话的草稿')
  await page.locator(`nav a[href="${new URL(firstSession).pathname}"]`).click()
  await expect(page).toHaveURL(firstSession)
  await expect(box).toHaveValue('')
})

test('首次发送失败保留图片和文字，重试不重复新建会话', async ({ page }) => {
  await page.route(
    '**/api/sessions/*/messages',
    (route) => route.fulfill({ status: 503, json: { error: '发送测试失败' } }),
    { times: 1 },
  )
  await page.goto('/workspace')
  const box = page.getByRole('textbox', { name: '研究问题' })
  const form = page.getByRole('form', { name: '提问' })
  await box.fill('保留草稿')
  await page.getByLabel('选择图片').setInputFiles(png)
  await box.press('Enter')
  await expect(page.getByRole('alert')).toContainText('发送测试失败')
  await expect(page).toHaveURL(/\/workspace$/)
  await expect(box).toHaveValue('保留草稿')
  await expect(form.getByRole('img', { name: '待发送.png' })).toBeVisible()
  const sessions = await (await page.request.get('/api/sessions')).json()
  expect(sessions).toHaveLength(1)
  await box.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/workspace/${sessions[0].id}$`))
  await expect(page.getByRole('heading', { name: '测试回答' })).toBeVisible()
  await expect(box).toHaveValue('')
  await expect(form.getByRole('img')).toHaveCount(0)
  expect(await (await page.request.get('/api/sessions')).json()).toHaveLength(1)
})

test('等待确认时重新输入相同问题，首次跳转后保留新问题与新附图', async ({ page }) => {
  const pending = await holdPost(page, '**/api/sessions/*/messages')
  await page.goto('/workspace')
  const box = page.getByRole('textbox', { name: '研究问题' })
  const form = page.getByRole('form', { name: '提问' })
  await box.fill('分析这张图')
  await page.getByLabel('选择图片').setInputFiles({ ...png, name: '第一张.png' })
  await box.press('Enter')
  const request = await pending.started
  await box.fill('')
  await box.fill('分析这张图')
  await page.getByLabel('选择图片').setInputFiles({ ...png, name: '第二张.png' })
  await request.continue()
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: '测试回答' })).toBeVisible()
  await expect(box).toHaveValue('分析这张图')
  await expect(form.getByRole('img', { name: '第一张.png' })).toHaveCount(0)
  await expect(form.getByRole('img', { name: '第二张.png' })).toBeVisible()
  await expect(page.getByRole('button', { name: '发送' })).toHaveAttribute('aria-disabled', 'false')
  const second = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().endsWith('/messages'),
  )
  await box.press('Enter')
  expect((await second).postDataJSON()).toMatchObject({
    question: '分析这张图',
    images: [{ name: '第二张.png' }],
  })
  await expect(box).toHaveValue('')
  await expect(form.getByRole('img')).toHaveCount(0)
})

test('手机上点新建研究：关闭抽屉、聚焦输入框，发出问题前不建会话', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/workspace')
  await page.getByRole('button', { name: '切换侧栏' }).click()
  await page.getByRole('link', { name: '新建研究' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(/\/workspace$/)
  await expect(page.getByRole('textbox', { name: '研究问题' })).toBeFocused()
  expect(await (await page.request.get('/api/sessions')).json()).toEqual([])
})

test('同一会话断线后重连读取失败，恢复时保留草稿和附图并可继续发送', async ({ page }) => {
  const response = await page.request.post('/api/sessions')
  expect(response.ok()).toBe(true)
  const session = await response.json()
  const path = `/api/sessions/${session.id}`
  // Exercise the real EventSource failure handler with a controlled SSE response.
  await page.route(
    `**${path}/events`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: failure\ndata: {}\n\n',
      }),
    { times: 1 },
  )
  await page.goto(`/workspace/${session.id}`)
  await expect(page.getByRole('alert')).toContainText('执行状态读取失败')
  const box = page.getByRole('textbox', { name: '研究问题' })
  const form = page.getByRole('form', { name: '提问' })
  await box.fill('重连前的未发送草稿')
  await page.getByLabel('选择图片').setInputFiles(png)
  await page.route(
    `**${path}`,
    (route) => route.fulfill({ status: 503, json: { error: '重连读取失败' } }),
    { times: 1 },
  )
  await page.getByRole('button', { name: '重新连接' }).click()
  await expect(page.getByRole('alert')).toContainText('重连读取失败')
  await expect(form).toBeHidden()
  await page.getByRole('button', { name: '重试加载' }).click()
  await expect(box).toHaveValue('重连前的未发送草稿')
  await expect(form.getByRole('img', { name: '待发送.png' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/workspace/${session.id}$`))
  await box.press('Enter')
  await expect(page.getByRole('heading', { name: '测试回答' })).toBeVisible()
  await expect(box).toHaveValue('')
  await expect(form.getByRole('img')).toHaveCount(0)
  await expect(page.getByRole('list', { name: '问题附图' }).getByRole('img')).toBeVisible()
})
