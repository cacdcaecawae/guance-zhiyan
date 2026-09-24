import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

test('正式本机入口无需登录，经原生适配器完成多轮流式聊天与停止', async ({ page }, info) => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-local-e2e-'))
  let userTurns = 0
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    userTurns = body.messages.filter((message: { role: string }) => message.role === 'user').length
    const last = JSON.stringify(body.messages.at(-1))
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const emit = (event: { type: string; [key: string]: unknown }) =>
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    emit({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    emit({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '本机协议测试回答' },
    })
    if (last.includes('停止测试')) return // Keep the real SSE transport open until cancellation.
    emit({ type: 'content_block_stop', index: 0 })
    emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })
    emit({ type: 'message_stop' })
    response.end()
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('Missing test provider address')
  const appOrigin = 'http://127.0.0.1:3002'
  const child = spawn(process.execPath, ['server/index.ts', '--local'], {
    windowsHide: true,
    env: {
      ...process.env,
      PORT: '3002',
      HOST: '0.0.0.0',
      APP_ORIGIN: 'http://unused.test',
      DATA_DIR: root,
      DEEPSEEK_API_KEY: 'test-only',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  child.stdout.on('data', (chunk) => {
    diagnostics += chunk
  })
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk
  })
  try {
    await expect
      .poll(async () => {
        try {
          return (await page.request.get(appOrigin + '/api/health')).status()
        } catch {
          return 0
        }
      })
      .toBe(200)
    await page.goto(appOrigin)
    await expect(page.getByText('本机研究者', { exact: true })).toBeVisible()
    const box = page.getByRole('textbox', { name: '研究问题' })
    await box.fill('你好')
    await box.press('Enter')
    await expect(page.getByRole('article', { name: '回答' })).toContainText('本机协议测试回答')
    await box.fill('继续')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.getByRole('article', { name: '回答' })).toHaveCount(2)
    expect(userTurns).toBe(2)
    await page.reload()
    await expect(page.getByRole('article', { name: '回答' })).toHaveCount(2)
    await box.fill('停止测试')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.getByRole('article', { name: '回答' }).last()).toContainText(
      '本机协议测试回答',
    )
    await page.getByRole('button', { name: '停止生成' }).click()
    await expect(page.getByRole('status')).toContainText('已停止')
    expect(
      (
        await page.request.get(appOrigin + '/api/me', { headers: { Origin: 'https://evil.test' } })
      ).status(),
    ).toBe(401)
    expect(
      (
        await page.request.get(appOrigin + '/api/me', {
          headers: { 'X-Forwarded-For': '192.168.1.2' },
        })
      ).status(),
    ).toBe(401)
  } finally {
    await info.attach('local-server-log', { body: diagnostics, contentType: 'text/plain' })
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    provider.closeAllConnections()
    await new Promise<void>((done) => provider.close(() => done()))
    expect(
      resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-local-e2e-'),
    ).toBe(true)
    await rm(root, { recursive: true })
  }
})
