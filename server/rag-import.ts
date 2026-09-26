import { createReadStream } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Store } from './store.ts'
import { LibraryStore, documentInput, type DocumentInput } from './rag-store.ts'
import { KnowledgeLibrary, ragConfig } from './rag.ts'
import { configureNetwork } from './network.ts'

/** JSONL is our import format, not an assumption about the school's source schema. */
export async function* readDocuments(path: string, signal?: AbortSignal) {
  let pending = Buffer.alloc(0)
  let line = 0
  // ponytail: lines are capped at 32 MiB; buffer chunks separately if large-line copying dominates imports.
  for await (const part of createReadStream(path, { signal })) {
    pending = Buffer.concat([pending, part])
    let boundary: number
    while ((boundary = pending.indexOf(10)) >= 0) {
      const data = pending.subarray(0, boundary)
      pending = pending.subarray(boundary + 1)
      line++
      if (data.length > 32 * 1024 * 1024) throw new Error(`第 ${line} 行超过 32 MiB。`)
      if (!data.toString('utf8').trim()) continue
      yield parse(data, line)
    }
    if (pending.length > 32 * 1024 * 1024) throw new Error(`第 ${line + 1} 行超过 32 MiB。`)
  }
  if (pending.toString('utf8').trim()) yield parse(pending, line + 1)
}

function parse(data: Buffer, line: number): DocumentInput {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    return documentInput(JSON.parse(text))
  } catch {
    throw new Error(`第 ${line} 行不是有效 UTF-8 文献 JSON，请核对字段与正文。`)
  }
}

async function main() {
  const [command, path, ...extra] = process.argv.slice(2)
  if (
    extra.length ||
    (command !== 'import' && command !== 'reindex') ||
    (command === 'import' ? !path : !!path)
  )
    throw new Error('用法：pnpm rag import <文献.jsonl> 或 pnpm rag reindex')
  const config = ragConfig()
  if (!config) throw new Error('请先配置 EMBEDDING_URL、EMBEDDING_MODEL、EMBEDDING_DIMENSIONS。')
  const store = new Store(resolve(process.env.DATA_DIR ?? 'server/data'))
  const lockPath = join(store.root, 'rag-import.lock')
  let lock: Awaited<ReturnType<typeof open>> | undefined
  let disposeNetwork: (() => Promise<void>) | undefined
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    try {
      lock = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('已有导入任务或遗留 rag-import.lock；确认旧进程已结束后再移除锁文件。')
      throw error
    }
    await lock.writeFile(String(process.pid))
    disposeNetwork = await configureNetwork()
    const library = new KnowledgeLibrary(new LibraryStore(store), config)
    let count = 0
    if (command === 'import') {
      for await (const input of readDocuments(resolve(path!), controller.signal)) {
        const result = await library.import(input, controller.signal)
        console.info(`已完成 ${++count} 篇，当前文献 ${result.chunks} 个片段。`)
      }
    } else {
      // Until every current document is rebuilt, answering fails explicitly rather than mixing spaces.
      store.db
        .prepare('DELETE FROM rag_indexed_versions WHERE fingerprint=?')
        .run(library.indexFingerprint!)
      let lastId = ''
      for (;;) {
        controller.signal.throwIfAborted()
        const row = store.db
          .prepare(
            `SELECT d.id, v.title, v.text, v.source_url, v.published_at
            FROM rag_documents d JOIN rag_versions v ON v.id=d.version_id
            WHERE d.id>? ORDER BY d.id LIMIT 1`,
          )
          .get(lastId)
        if (!row) break
        await library.import(
          {
            id: row.id as string,
            title: row.title as string,
            text: row.text as string,
            ...(row.source_url ? { sourceUrl: row.source_url as string } : {}),
            ...(row.published_at ? { publishedAt: row.published_at as string } : {}),
          },
          controller.signal,
        )
        lastId = row.id as string
        console.info(`已重建 ${++count} 篇。`)
      }
    }
    console.info(`任务完成，共处理 ${count} 篇文献。`)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await disposeNetwork?.()
    if (lock) {
      await lock.close()
      await unlink(lockPath)
    }
    store.close()
  }
}

if (import.meta.main)
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : '导入失败。')
    process.exitCode = 1
  })
