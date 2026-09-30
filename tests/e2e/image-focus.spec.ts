import { expect, test } from '@playwright/test'

test('键盘移除待发送图片后焦点回到问题输入框', async ({ page, context }, info) => {
  await context.addCookies([
    {
      name: 'test_user',
      value: `image-focus-${info.workerIndex}-${Date.now()}`,
      url: 'http://localhost:4173',
    },
  ])
  await page.goto('/workspace')
  await page.getByLabel('选择图片').setInputFiles(
    [0, 1, 2].map((index) => ({
      name: `${index}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    })),
  )
  const box = page.getByRole('textbox', { name: '研究问题' })
  for (const index of [1, 2, 0]) {
    const remove = page.getByRole('button', { name: `移除图片 ${index}.png` })
    await remove.focus()
    await remove.press(index === 2 ? 'Space' : 'Enter')
    await expect(remove).toHaveCount(0)
    await expect(box).toBeFocused()
    await page.keyboard.type('next')
  }
  await expect(box).toHaveValue('nextnextnext')
  await expect(page.getByRole('form', { name: '提问' }).getByRole('img')).toHaveCount(0)
  await expect(page).toHaveURL(/\/workspace$/)
})
