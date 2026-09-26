import { defineConfig, devices } from '@playwright/test'

const PORT = 4173
const backendPort = Number(process.env.E2E_BACKEND_PORT ?? 3001)
if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535)
  throw new Error('E2E_BACKEND_PORT 无效。')

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node tests/support/server.ts',
      url: `http://127.0.0.1:${backendPort}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: `pnpm dev --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      // 不复用已占用端口上的服务器，避免测到 vite preview（默认同为 4173）或其他 worktree 的代码
      reuseExistingServer: false,
    },
  ],
})
