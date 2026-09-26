import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Store } from '../../server/store.ts'
import { LibraryStore } from '../../server/rag-store.ts'
import { KnowledgeLibrary } from '../../server/rag.ts'

test.describe.configure({ mode: 'serial' })
for (const supplier of ['deepseek-official', 'qianwen']) {
  test(`正式本机入口无需登录，${supplier} 原生适配器完成多轮流式聊天与停止`, async ({
    page,
  }, info) => {
    const root = await mkdtemp(join(tmpdir(), 'gczy-local-e2e-'))
    let userTurns = 0
    let collectionExists = false
    let retrievals = 0
    let citationPath = ''
    const pointIds = new Set<string>()
    const source = {
      id: 'local-e2e-source',
      title: '本机入口测试文献（非真实政策）',
      text: '第一条 本段是自动化测试夹具，不是真实政策。测试事项的办理期限为三个工作日。',
    }
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString()
      const body = raw ? JSON.parse(raw) : undefined
      const path = request.url?.split('?')[0] ?? ''
      if (path === '/embeddings') {
        expect(request.headers.authorization).toBe('Bearer embedding-test-only')
        expect(body.model).toBe('test-embedding')
        expect(body.dimensions).toBe(2)
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({
            data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })),
          }),
        )
        return
      }
      if (path.startsWith('/collections/')) {
        let result: unknown
        if (request.method === 'GET') {
          if (!collectionExists) {
            response.writeHead(404)
            response.end()
            return
          }
          result = { config: { params: { vectors: { size: 2, distance: 'Cosine' } } } }
        } else if (path.endsWith('/points/query')) {
          retrievals++
          result = {
            points: [...pointIds]
              .slice(body.offset, body.offset + body.limit)
              .map((id) => ({ id, score: 1 })),
          }
        } else if (path.endsWith('/points/delete')) {
          for (const id of body.points) pointIds.delete(id)
          result = { status: 'completed', operation_id: 1 }
        } else if (path.endsWith('/points')) {
          for (const point of body.points) pointIds.add(point.id)
          result = { status: 'completed', operation_id: 1 }
        } else {
          expect(body.vectors).toEqual({ size: 2, distance: 'Cosine' })
          collectionExists = true
          result = true
        }
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ status: 'ok', result }))
        return
      }
      expect(request.headers['x-api-key']).toBe(
        supplier === 'qianwen' ? 'qianwen-test-only' : 'test-only',
      )
      expect(body.model).toBe(supplier === 'qianwen' ? 'deepseek-v4.1-flash' : 'deepseek-flash')
      expect(JSON.stringify(body.messages)).toContain(citationPath)
      expect(JSON.stringify(body.messages)).toContain(source.text)
      userTurns = body.messages.filter(
        (message: { role: string }) => message.role === 'user',
      ).length
      const last = JSON.stringify(body.messages.at(-1))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const emit = (event: { type: string; [key: string]: unknown }) =>
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      emit({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      emit({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: `本机协议测试回答：测试事项期限为三个工作日。[原文 1](${citationPath})`,
        },
      })
      if (last.includes('停止测试')) return // Keep the real SSE transport open until cancellation.
      emit({ type: 'content_block_stop', index: 0 })
      emit({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 8 },
      })
      emit({ type: 'message_stop' })
      response.end()
    })
    try {
      provider.listen(0, '127.0.0.1')
      await once(provider, 'listening')
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('Missing test provider address')
      const providerOrigin = `http://127.0.0.1:${address.port}`
      const store = new Store(root)
      try {
        const library = new KnowledgeLibrary(new LibraryStore(store), {
          embedding: {
            url: `${providerOrigin}/embeddings`,
            model: 'test-embedding',
            dimensions: 2,
            apiKey: 'embedding-test-only',
          },
          qdrant: { url: providerOrigin },
        })
        const imported = await library.import(source)
        citationPath = `/api/library/passages/${library.documents.chunks(imported.versionId)[0].id}`
      } finally {
        store.close()
      }
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
          QIANWEN_API_KEY: 'qianwen-test-only',
          QIANWEN_BASE_URL: `http://127.0.0.1:${address.port}/qianwen`,
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          EMBEDDING_URL: `${providerOrigin}/embeddings`,
          EMBEDDING_MODEL: 'test-embedding',
          EMBEDDING_DIMENSIONS: '2',
          EMBEDDING_API_KEY: 'embedding-test-only',
          QDRANT_URL: providerOrigin,
          QDRANT_API_KEY: '',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          http_proxy: '',
          https_proxy: '',
          all_proxy: '',
          NO_PROXY: '*',
          no_proxy: '*',
          NODE_USE_ENV_PROXY: '0',
          SANDBOX_URL: '',
          SANDBOX_API_KEY: '',
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
        const model = page.getByRole('combobox', { name: '模型' })
        const platform = supplier === 'qianwen' ? '千问 AI 平台' : 'DeepSeek 官方'
        await model.click()
        await page
          .getByRole('group', { name: platform })
          .getByRole('option', { name: 'DeepSeek V4.1 Flash', exact: true })
          .click()
        await expect(model).toContainText(`DeepSeek V4.1 Flash · ${platform}`)
        await box.fill('你好')
        await box.press('Enter')
        await expect(page.getByRole('article', { name: '回答' })).toContainText('本机协议测试回答')
        const citation = page
          .getByRole('article', { name: '回答' })
          .getByRole('link', { name: '原文 1' })
        await expect(citation).toHaveAttribute('href', citationPath)
        const [original] = await Promise.all([page.waitForEvent('popup'), citation.click()])
        await expect(original).toHaveURL(appOrigin + citationPath)
        await expect(original.getByRole('heading', { level: 1 })).toHaveText(source.title)
        await expect(original.locator('pre')).toHaveText(source.text)
        await expect(original.getByText('文献版本', { exact: true })).toBeVisible()
        await original.close()
        await box.fill('继续')
        await page.getByRole('button', { name: '发送' }).click()
        await expect(page.getByRole('article', { name: '回答' })).toHaveCount(2)
        expect(userTurns).toBe(2)
        await page.reload()
        await expect(page.getByRole('article', { name: '回答' })).toHaveCount(2)
        await box.fill('停止测试')
        await page.getByRole('button', { name: '发送' }).click()
        await expect(page.getByRole('article', { name: '回答' })).toHaveCount(3)
        await expect(page.getByRole('article', { name: '回答' }).last()).toContainText(
          '本机协议测试回答',
        )
        await page.getByRole('button', { name: '停止生成' }).click()
        await expect(page.getByRole('status')).toContainText('已停止')
        expect(retrievals).toBe(3)
        expect(
          (
            await page.request.get(appOrigin + '/api/me', {
              headers: { Origin: 'https://evil.test' },
            })
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
      }
    } finally {
      provider.closeAllConnections()
      await new Promise<void>((done) => provider.close(() => done()))
      expect(
        resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-local-e2e-'),
      ).toBe(true)
      await rm(root, { recursive: true })
    }
  })
}
