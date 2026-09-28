/** Worker for LibraryStore.lexical: one read-only FTS5 query per worker, off the main thread. */
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

const { path, match, limit } = workerData as { path: string; match: string; limit: number }
const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 })
try {
  parentPort!.postMessage(
    db
      .prepare(
        `SELECT c.id FROM rag_fts f JOIN rag_chunks c ON c.rowid=f.rowid
        WHERE rag_fts MATCH ? ORDER BY bm25(rag_fts, 5, 1), c.id LIMIT ?`,
      )
      .all(match, limit)
      .map((row) => row.id as string),
  )
} finally {
  db.close()
}
