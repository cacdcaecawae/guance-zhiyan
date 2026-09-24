// Runs INSIDE the sandbox image as uid 1000, never in the web server process.
// Reuse DSH's canonical paths, UTF-8 validation, stale guards and atomic edits.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'

const ctx = new Context()
await ctx.plugin(LocalFileSystem)
try {
  const { method, args } = JSON.parse(await readFile(process.argv[2], 'utf8'))
  const allowed = [
    'resolve',
    'stat',
    'lstat',
    'readText',
    'readBytes',
    'readByteRange',
    'listDir',
    'writeText',
    'editText',
  ]
  let value
  if (method === 'writeBytes') {
    const target = await ctx.fs.resolve(args[0])
    const path = ctx.fs.processPath(target)
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, Buffer.from(args[1], 'base64'), { flag: 'wx', mode: 0o600 })
      await rename(temp, path)
    } finally {
      await unlink(temp).catch(() => {})
    }
  } else {
    if (!allowed.includes(method)) throw new Error('Unsupported filesystem operation')
    // JSON null represents an omitted optional argument on the wire.
    value = await ctx.fs[method](...args.map((arg) => (arg === null ? undefined : arg)))
    if (value instanceof Uint8Array) value = Buffer.from(value).toString('base64')
  }
  process.stdout.write(JSON.stringify({ value }))
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: { code: error.code ?? 'FS_IO_ERROR', message: error.message } }),
  )
} finally {
  await ctx.fiber.dispose()
}
