/** Worker for LibraryStore.lexical: one read-only FTS5 query per worker, off the main thread. */
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

const { path, match, limit } = workerData as { path: string; match: string; limit: number }
const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 })
try {
  parentPort!.postMessage(
    db
      // At most 5 chunks per document, so one long document cannot take every lexical candidate.
      .prepare(
        `SELECT id FROM (
          SELECT id, score, row_number() OVER (PARTITION BY version_id ORDER BY score, id) AS n
          FROM (SELECT c.id, c.version_id, bm25(rag_fts, 5, 1) AS score
            FROM rag_fts f JOIN rag_chunks c ON c.rowid=f.rowid WHERE rag_fts MATCH ?)
        ) WHERE n <= 5 ORDER BY score, id LIMIT ?`,
      )
      .all(match, limit)
      .map((row) => row.id as string),
  )
} finally {
  db.close()
}
