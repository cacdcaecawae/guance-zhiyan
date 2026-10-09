/** Worker for LibraryStore.lexical: read-only keyword retrieval off the main thread. */
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

const { path, match, limit, documentIds } = workerData as {
  path: string
  match: string
  limit: number
  documentIds?: string[]
}
const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 })
try {
  // A metadata filter keeps chunks of these documents only. Restricting FTS to their rowids
  // (`rowid IN …`) took 8–80 s on the full library, so the ranked pool is widened instead.
  // ponytail: a narrow filter (one county) may keep few lexical hits from the top 5000; dense
  // retrieval is filtered exactly in Qdrant and carries recall there. Score the subset directly
  // if evaluation shows lexical misses under narrow filters.
  if (documentIds) {
    db.exec('CREATE TEMP TABLE allowed(id TEXT PRIMARY KEY)')
    db.prepare('INSERT INTO temp.allowed SELECT value FROM json_each(?)').run(
      JSON.stringify(documentIds),
    )
  }
  // The vocab view lives only in this connection's temp database; the source index stays read-only.
  db.exec("CREATE VIRTUAL TABLE temp.rag_vocab USING fts5vocab(main, rag_fts, 'row')")
  // SQLite guarantees FTS3/5 unicode61 compatibility; use its tokenizer rather than JS folding.
  db.exec('CREATE VIRTUAL TABLE temp.rag_query_tokens USING fts3tokenize(unicode61)')
  const total = Number(db.prepare('SELECT count(*) AS n FROM rag_fts_docsize').get()!.n)
  const frequency = db.prepare('SELECT doc FROM rag_vocab WHERE term=?')
  const queryTokens = db.prepare('SELECT token FROM rag_query_tokens WHERE input=? LIMIT 2')
  const clauses = match.split(' OR ')
  // Keep phrases and unknown tokens: vocab frequencies describe single FTS terms, not phrases.
  const counts = clauses.map((clause) => {
    if (clause.includes(' ')) return 0
    const tokens = queryTokens.all(clause.slice(1, -1).replaceAll('""', '"'))
    // A segment such as "can't" becomes an FTS phrase, despite having no literal spaces.
    if (tokens.length !== 1) return 0
    return Number(frequency.get(tokens[0].token!)?.doc ?? 0)
  })
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
              ORDER BY rank LIMIT ?) f JOIN rag_chunks c ON c.rowid=f.rowid
            ${documentIds ? 'JOIN rag_versions v ON v.id=c.version_id JOIN temp.allowed a ON a.id=v.document_id' : ''})
        ) WHERE n <= 5 ORDER BY score, id LIMIT ?`,
      )
      // ponytail: cap the ranked pool at 1000; widen it only if recall evaluation needs more.
      .all(selected, documentIds ? 5000 : 1000, limit)
      .map((row) => row.id as string),
  )
} finally {
  db.close()
}
