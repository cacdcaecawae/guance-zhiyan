import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Store } from '../../server/store.ts'
import { Accounts } from '../../server/accounts.ts'

test('正式服务器入口：账号登录、刷新保持、退出后回到登录页', async ({ page, context }, info) => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-accounts-e2e-'))
  const store = new Store(root)
  try {
    const accounts = new Accounts(store)
    await accounts.add('alice', 'alice-test-password')
    await accounts.add('bob', 'bob-test-password')
  } finally {
    store.close()
  }
  const origin = 'http://127.0.0.1:3003'
  const child = spawn(process.execPath, ['server/index.ts'], {
    windowsHide: true,
    env: {
      ...process.env,
      PORT: '3003',
      HOST: '127.0.0.1',
      APP_ORIGIN: origin,
      DATA_DIR: root,
      DEEPSEEK_API_KEY: '',
      QIANWEN_API_KEY: '',
      CAMPUS_API_KEY: '',
      EMBEDDING_URL: '',
      SANDBOX_URL: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  child.stdout.on('data', (chunk) => (diagnostics += chunk))
  child.stderr.on('data', (chunk) => (diagnostics += chunk))
  try {
    // 与其他浏览器测试并行时启动较慢
    await expect
      .poll(
        async () => {
          try {
            return (await page.request.get(origin + '/api/health')).status()
          } catch {
            return 0
          }
        },
        { timeout: 30_000 },
      )
      .toBe(200)
    await page.goto(origin + '/library')
    const username = page.getByLabel('用户名')
    const password = page.getByLabel('密码')
    await username.fill('alice')
    await password.fill('wrong-password')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page.getByRole('alert')).toHaveText('用户名或密码错误。')

    await password.fill('alice-test-password')
    await password.press('Enter')
    const account = page.getByTitle('当前账号：alice')
    await expect(account).toBeVisible()
    // 登录后留在原来要打开的页面
    await expect(page).toHaveURL(origin + '/library')
    const [cookie] = await context.cookies(origin)
    expect(cookie).toMatchObject({ name: 'gczy_session', httpOnly: true, sameSite: 'Lax' })
    await page.reload()
    await expect(account).toBeVisible()

    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(username).toBeVisible()
    expect((await page.request.get(origin + '/api/me')).status()).toBe(401)
    await page.reload()
    await expect(username).toBeVisible()

    await username.fill('BOB')
    await password.fill('bob-test-password')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page.getByTitle('当前账号：bob')).toBeVisible()
    await expect(page.getByRole('textbox', { name: '研究问题' })).toBeVisible()

    // 服务器模式下的验证集：登录后上传组委会模板、执行并导出；未配置模型密钥，各题如实记为失败
    await page.getByRole('link', { name: '验证集测试' }).click()
    await page.getByLabel('选择验证集文件').setInputFiles('tests/fixtures/valset-template-4.xlsx')
    await page.getByRole('button', { name: '开始测试' }).click()
    await expect(page.getByRole('status').filter({ hasText: '已完成' })).toHaveText(
      '已完成 3 / 3 题 · 失败 3',
    )
    await expect(page.getByRole('row').nth(1)).toContainText('尚未配置')
    const [result] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: '导出结果 Excel' }).click(),
    ])
    expect(result.suggestedFilename()).toBe('验证集结果-valset-template-4.xlsx')
  } finally {
    await info.attach('server-log', { body: diagnostics, contentType: 'text/plain' })
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    expect(
      resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-accounts-e2e-'),
    ).toBe(true)
    await rm(root, { recursive: true })
  }
})
