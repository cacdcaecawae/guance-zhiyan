import { expect, test } from '@playwright/test'

test.describe('演示链路', () => {
  test('新建研究 → 选择示例问题 → 查看回答 → 打开并关闭引用', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/workspace$/)

    await page.getByRole('button', { name: '新建研究' }).click()
    await expect(page).toHaveURL(/\/workspace\/s-/)
    await expect(page.getByRole('heading', { name: '开始一项研究' })).toBeVisible()

    await page.getByRole('button', { name: /示例文件 B 中试点工作/ }).click()
    await expect(page.getByRole('status')).toContainText('正在获取演示回答')
    await expect(page.getByRole('article', { name: '回答' })).toContainText('三个阶段')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('示例文件 B 中试点工作')

    await page.getByRole('button', { name: '查看引用 1' }).click()
    const panel = page.getByRole('complementary', { name: '资料面板' })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('示例文件 B')
    await expect(panel).toContainText('第三章 实施步骤')
    await expect(panel).toContainText('#7')
    await expect(panel.locator('mark')).toHaveText('准备、试运行、评估推广三个阶段')

    await page.getByRole('button', { name: '关闭资料面板' }).click()
    await expect(panel).toBeHidden()
  })

  test('输入“演示失败”显示错误并可重试', async ({ page }) => {
    await page.goto('/workspace')
    await page.getByRole('textbox', { name: '研究问题' }).fill('演示失败')
    await page.keyboard.press('Enter')
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('模拟数据请求失败')
    await page.getByRole('button', { name: '重试' }).click()
    await expect(page.getByRole('status')).toContainText('正在获取演示回答')
    await expect(alert).toBeVisible()
  })

  test('长串与长链接自动折行，不产生横向滚动', async ({ page }) => {
    await page.goto('/workspace')
    const long = `编号 ${'A'.repeat(200)} 链接 https://example.org/${'x'.repeat(120)}`
    await page.getByRole('textbox', { name: '研究问题' }).fill(long)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('article', { name: '回答' })).toBeVisible()
    const scroller = page
      .getByRole('region', { name: '研究工作区' })
      .locator(':scope > div')
      .first()
    expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  })
})

test.describe('主题与布局', () => {
  test('主题切换生效并在刷新后保留', async ({ page }) => {
    await page.goto('/workspace')
    const html = page.locator('html')
    await page.getByRole('button', { name: '深色' }).click()
    await expect(html).toHaveClass(/dark/)
    await page.reload()
    await expect(html).toHaveClass(/dark/)
    await page.getByRole('button', { name: '浅色' }).click()
    await expect(html).not.toHaveClass(/dark/)
  })

  test('跟随系统：侧栏收起后仍随系统深浅色变化', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/workspace')
    const html = page.locator('html')
    await expect(html).not.toHaveClass(/dark/)
    await page.getByRole('button', { name: '切换侧栏' }).click()
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden()
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(html).toHaveClass(/dark/)
  })

  test('宽屏可折叠侧栏', async ({ page }) => {
    await page.goto('/workspace')
    const nav = page.getByRole('navigation', { name: '主导航' })
    const toggle = page.getByRole('button', { name: '切换侧栏' })
    await expect(nav).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(nav).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(nav).toBeVisible()
  })

  test('窄屏：侧栏与资料面板均为抽屉', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto('/workspace/s-demo-1')

    await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden()
    await page.getByRole('button', { name: '切换侧栏' }).click()
    const navDrawer = page.getByRole('dialog', { name: '导航' })
    await expect(navDrawer).toBeVisible()
    await navDrawer.getByRole('button', { name: '关闭' }).click()
    await expect(navDrawer).toBeHidden()
    await expect(page.getByRole('button', { name: '切换侧栏' })).toBeFocused()

    await page.getByRole('button', { name: '查看引用 3' }).click()
    const sourceDrawer = page.getByRole('dialog', { name: '资料面板' })
    await expect(sourceDrawer).toBeVisible()
    await expect(sourceDrawer.locator('mark')).toHaveText('平台化的数据共享与流程联动')
    await page.keyboard.press('Escape')
    await expect(sourceDrawer).toBeHidden()
    await expect(page.getByRole('button', { name: '查看引用 3' })).toBeFocused()

    const width = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(width).toBeLessThanOrEqual(390)
  })
})
