// 导出宣传片：逐帧调用 window.renderFrame(i) 截图，再用 ffmpeg 合成 H.264 MP4（不实时录屏）。
// 用法（在仓库根目录）：
//   node docs/brand/promo/render.mjs <输出目录>                 全片 → <输出目录>/promo.mp4
//   node docs/brand/promo/render.mjs <输出目录> --frames 30,300   只截这些帧 → <输出目录>/frame-00030.png …
// 需要 ffmpeg 在 PATH 中；画面依赖 jsDelivr 上的 GSAP，导出时需联网。
import { chromium } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = resolve(process.argv[2] ?? '.')
const at = process.argv.indexOf('--frames')
const only = at > 0 ? process.argv[at + 1].split(',').map(Number) : undefined
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
})
await page.goto(pathToFileURL(join(import.meta.dirname, 'index.html')).href)
await page.evaluate(() => window.ready)
const total = await page.evaluate(() => window.FRAMES)
const frames = only ?? Array.from({ length: total }, (_, i) => i)
const dir = only ? out : join(out, 'frames')
mkdirSync(dir, { recursive: true })
for (const [k, i] of frames.entries()) {
  await page.evaluate((i) => window.renderFrame(i), i)
  await page.screenshot({ path: join(dir, `frame-${String(i).padStart(5, '0')}.png`) })
  if (!only && k % 150 === 0) console.log(`${k}/${frames.length}`)
}
await browser.close()

if (!only) {
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      '30',
      '-i',
      join(dir, 'frame-%05d.png'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '18',
      '-preset',
      'slow',
      '-movflags',
      '+faststart',
      join(out, 'promo.mp4'),
    ],
    { stdio: 'inherit' },
  )
  if (r.status !== 0) process.exit(r.status ?? 1)
  rmSync(dir, { recursive: true })
  console.log(`→ ${join(out, 'promo.mp4')}`)
} else console.log(`→ ${frames.length} frames in ${out}`)
