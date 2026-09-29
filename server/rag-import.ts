import { createReadStream } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Store } from './store.ts'
import { LibraryStore, documentInput, type DocumentInput } from './rag-store.ts'
import { KnowledgeLibrary, ragConfig } from './rag.ts'
import { configureNetwork } from './network.ts'

/**
 * JSONL is our import format, not an assumption about the school's source schema. An invalid line
 * stops the import unless onInvalid is given, which then receives the error and reading continues.
 */
export async function* readDocuments(
  path: string,
  signal?: AbortSignal,
  onInvalid?: (error: Error) => void,
) {
  const read = (data: Buffer, line: number) => {
    try {
      return parse(data, line)
    } catch (error) {
      if (!onInvalid) throw error
      onInvalid(error as Error)
    }
  }
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
      const input = read(data, line)
      if (input) yield input
    }
    if (pending.length > 32 * 1024 * 1024) throw new Error(`第 ${line + 1} 行超过 32 MiB。`)
  }
  const last = pending.toString('utf8').trim() ? read(pending, line + 1) : undefined
  if (last) yield last
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
  const args = process.argv.slice(2)
  const skipInvalid = args.includes('--skip-invalid')
  const force = args.includes('--force')
  const [command, path, ...extra] = args.filter(
    (arg) => arg !== '--skip-invalid' && arg !== '--force',
  )
  if (
    extra.length ||
    (command !== 'import' && command !== 'reindex') ||
    (command === 'import' ? !path || force : !!path || skipInvalid)
  )
    throw new Error(
      '用法：pnpm rag import <文献.jsonl> [--skip-invalid] 或 pnpm rag reindex [--force]',
    )
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
    let skipped = 0
    let invalid = 0
    if (command === 'import') {
      const onInvalid = skipInvalid
        ? (error: Error) => {
            invalid++
            console.warn(`已跳过：${error.message}`)
          }
        : undefined
      for await (const input of readDocuments(resolve(path!), controller.signal, onInvalid)) {
        const result = await library.import(input, controller.signal)
        if (result.skipped) skipped++
        console.info(
          `已处理 ${++count} 篇，当前文献${result.skipped ? '已索引，跳过' : ` ${result.chunks} 个片段`}。`,
        )
      }
    } else {
      // Documents already indexed for this vector space are skipped, so an interrupted rebuild
      // resumes. After a model change the new space has no markers and answering fails with
      // RAG_NOT_INDEXED until every document is rebuilt, rather than mixing vector spaces.
      // --force declares the vectors untrusted (Qdrant data restored or edited, same-named model
      // weights changed): answering fails the same way until the rebuild completes, and a plain
      // reindex resumes an interrupted one.
      if (force) library.invalidate()
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
        const result = await library.import(
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
        if (result.skipped) skipped++
        console.info(`已处理 ${++count} 篇${result.skipped ? '（已索引，跳过）' : ''}。`)
      }
    }
    console.info(
      `任务完成，共处理 ${count} 篇文献，其中 ${skipped} 篇已索引而跳过` +
        (skipInvalid ? `；另有 ${invalid} 行无效数据被跳过。` : '。'),
    )
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
