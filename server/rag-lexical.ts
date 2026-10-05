/** Worker for LibraryStore.lexical: read-only keyword retrieval off the main thread. */
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

const { path, match, limit } = workerData as { path: string; match: string; limit: number }
const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 })
try {
  // The vocab view lives only in this connection's temp database; the source index stays read-only.
  db.exec("CREATE VIRTUAL TABLE temp.rag_vocab USING fts5vocab(main, rag_fts, 'row')")
  const total = Number(db.prepare('SELECT count(*) AS n FROM rag_fts_docsize').get()!.n)
  const frequency = db.prepare('SELECT doc FROM rag_vocab WHERE term=?')
  const clauses = match.split(' OR ')
  // Keep phrases and unknown tokens: vocab frequencies describe single FTS terms, not phrases.
  const counts = clauses.map((clause) =>
    clause.includes(' ')
      ? 0
      : Number(frequency.get(clause.slice(1, -1).replaceAll('""', '"').toLowerCase())?.doc ?? 0),
  )
  // Prune very common terms only when a known, less common term remains; broad-only queries work.
  const selected = counts.some((count) => count > 0 && count <= total / 2)
    ? clauses.filter((_, i) => counts[i] <= total / 2).join(' OR ')
    : match
  parentPort!.postMessage(
    db
      // At most 5 chunks per document, so one long document cannot take every lexical candidate.
      .prepare(
        `SELECT id FROM (
          SELECT id, score, row_number() OVER (PARTITION BY version_id ORDER BY score, id) AS n
          FROM (SELECT c.id, c.version_id, f.rank AS score
            FROM (SELECT rowid, rank FROM rag_fts
              WHERE rag_fts MATCH ? AND rank MATCH 'bm25(5, 1)'
              ORDER BY rank LIMIT ?) f JOIN rag_chunks c ON c.rowid=f.rowid)
        ) WHERE n <= 5 ORDER BY score, id LIMIT ?`,
      )
      // ponytail: cap the ranked pool at 1000; widen it only if recall evaluation needs more.
      .all(selected, 1000, limit)
      .map((row) => row.id as string),
  )
} finally {
  db.close()
}
