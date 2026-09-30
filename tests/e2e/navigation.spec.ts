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
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await page.unroute(path, handler)
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
  await page.getByRole('button', { name: '新建研究' }).click()
  await expect(page).not.toHaveURL(firstSession)
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

for (const returnToWorkspace of [false, true]) {
  test(`新建研究的延迟完成不覆盖更新的导航${returnToWorkspace ? '，包括离开后返回同一地址' : ''}`, async ({
    page,
  }) => {
    const pending = await holdPost(page, '**/api/sessions')
    await page.goto('/workspace')
    await page.getByRole('button', { name: '新建研究' }).click()
    const request = await pending.started
    await page.getByRole('link', { name: '文献库', exact: true }).click()
    if (returnToWorkspace) {
      await page.getByRole('link', { name: '研究工作台', exact: true }).click()
      await page.getByRole('textbox', { name: '研究问题' }).fill('返回后的草稿')
    }
    const destination = page.url()
    const response = await request.fetch()
    const created = await response.json()
    await request.fulfill({ response })
    // The sidebar link proves the response has reached the application's store.
    await expect(page.locator(`nav a[href="/workspace/${created.id}"]`)).toBeVisible()
    await expect(page).toHaveURL(destination)
    if (returnToWorkspace)
      await expect(page.getByRole('textbox', { name: '研究问题' })).toHaveValue('返回后的草稿')
  })
}

test('旧新建请求的失败不覆盖较新请求的状态；当前失败可重试并聚焦', async ({ page }) => {
  const stale = await holdPost(page, '**/api/sessions')
  await page.goto('/workspace')
  const button = page.getByRole('button', { name: '新建研究' })
  await button.click()
  const staleRequest = await stale.started
  await page.getByRole('link', { name: '文献库', exact: true }).click()
  await page.getByRole('link', { name: '研究工作台', exact: true }).click()
  const latest = await holdPost(page, '**/api/sessions')
  await button.click()
  const latestRequest = await latest.started
  await staleRequest.fulfill({ status: 503, json: { error: '过期的新建错误' } })
  await expect(button).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByText('过期的新建错误')).toHaveCount(0)
  await latestRequest.fulfill({ status: 503, json: { error: '当前的新建错误' } })
  await expect(page.getByRole('alert')).toContainText('当前的新建错误')
  await expect(button).toHaveAttribute('aria-disabled', 'false')
  await button.click()
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('textbox', { name: '研究问题' })).toBeFocused()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('手机关闭导航抽屉取消待完成新建的跳转，重新打开仍可正常新建', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  const pending = await holdPost(page, '**/api/sessions')
  await page.goto('/workspace')
  await page.getByRole('button', { name: '切换侧栏' }).click()
  await page.getByRole('button', { name: '新建研究' }).click()
  const request = await pending.started
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('textbox', { name: '研究问题' }).fill('关闭后继续输入')
  const response = await request.fetch()
  const created = await response.json()
  await request.fulfill({ response })
  await page.getByRole('button', { name: '切换侧栏' }).click()
  await expect(page.locator(`nav a[href="/workspace/${created.id}"]`)).toBeVisible()
  await expect(page).toHaveURL(/\/workspace$/)
  await page.getByRole('button', { name: '新建研究' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('textbox', { name: '研究问题' })).toHaveValue('')
  await expect(page.getByRole('textbox', { name: '研究问题' })).toBeFocused()
})
