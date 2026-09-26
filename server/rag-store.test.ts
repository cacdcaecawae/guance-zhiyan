import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { documentInput, LibraryStore, type DocumentInput } from './rag-store.ts'
import { Store } from './store.ts'

const document: DocumentInput = {
  id: 'test-policy',
  title: '自动化测试政策',
  text: '第一章 总则\r\n第一条 养老服务用于自动化测试。\r\n',
  sourceUrl: 'https://example.org/policies/test-policy',
  publishedAt: '2024-02-29',
}

test('document imports validate source text, real dates and credential-free HTTP sources', () => {
  assert.deepEqual(documentInput(document), document)
  const minimal = { id: '测试编号', title: '测试文件', text: '  原文\r\n保持原样。\n' }
  assert.deepEqual(documentInput({ ...minimal, unknown: 'ignored' }), minimal)
  assert.equal(
    documentInput({ ...minimal, sourceUrl: 'http://example.org/原文' }).sourceUrl,
    'http://example.org/原文',
  )

  for (const value of [undefined, null, true, 1, 'document', [], {}])
    assert.throws(() => documentInput(value), { status: 400 })
  for (const key of ['id', 'title', 'text'])
    for (const value of ['', ' \r\n\t', null, 42, '\ud800', 'text\0suffix'])
      assert.throws(() => documentInput({ ...document, [key]: value }), { status: 400 })
  for (const [key, length] of [
    ['id', 257],
    ['title', 1001],
    ['text', 5_000_001],
  ] as const)
    assert.throws(() => documentInput({ ...document, [key]: 'a'.repeat(length) }), { status: 400 })
  for (const sourceUrl of [
    null,
    1,
    '',
    '/relative',
    'javascript:alert(1)',
    'file:///tmp/policy',
    'https://user:password@example.org/policy',
    'https://user@example.org/policy',
    'https://example.org/' + 'a'.repeat(2048),
  ])
    assert.throws(() => documentInput({ ...document, sourceUrl }), { status: 400 })
  for (const publishedAt of [
    null,
    2024,
    '',
    '2023-02-29',
    '2024-02-30',
    '2024-13-01',
    '2024-00-01',
    '2024-01-00',
    '2024-1-01',
    '2024-01-01T00:00:00Z',
  ])
    assert.throws(() => documentInput({ ...document, publishedAt }), { status: 400 })
})

test('only published versions are searchable; old citations survive updates, conflicts and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-rag-store-test-'))
  let store = new Store(root)
  let library = new LibraryStore(store)
  try {
    const first = library.stage(document)
    assert.ok(first.chunks.length > 0)
    assert.equal(library.current(document.id), null)
    assert.equal(library.count(), 0)
    assert.deepEqual(library.list(), [])
    assert.deepEqual(library.lexical('养老'), [])
    assert.deepEqual(library.activePassages(first.chunks.map((chunk) => chunk.id)), [])
    for (const chunk of first.chunks)
      assert.throws(() => library.passage(chunk.id), { status: 404 })
    assert.throws(() => library.publish('unknown-version', null), { status: 404 })
    assert.deepEqual(library.stage(document), first)

    library.publish(first.versionId, null)
    assert.equal(library.current(document.id), first.versionId)
    assert.equal(library.count(), 1)
    assert.deepEqual(
      library.list().map((row) => ({ ...row })),
      [
        {
          id: document.id,
          versionId: first.versionId,
          title: document.title,
          sourceUrl: document.sourceUrl,
          publishedAt: document.publishedAt,
        },
      ],
    )
    const firstMatches = library.lexical('养老')
    assert.ok(firstMatches.length > 0)
    const citation = library.passage(firstMatches[0])
    assert.equal(citation.text, document.text.slice(citation.start, citation.end))
    assert.equal(citation.title, document.title)
    assert.equal(citation.sourceUrl, document.sourceUrl)
    assert.equal(citation.publishedAt, document.publishedAt)
    assert.equal(citation.documentId, document.id)
    assert.equal(citation.versionId, first.versionId)
    assert.deepEqual(library.stage(document), first)
    library.publish(first.versionId, first.versionId)
    assert.equal(library.count(), 1)
    assert.deepEqual(library.lexical('养老'), firstMatches)

    const pending = library.stage({ ...document, text: '第一条 住房保障用于自动化测试。' })
    const replacement = library.stage({
      ...document,
      title: '更新后的自动化测试政策',
      text: '第一条 教育服务用于自动化测试。',
      sourceUrl: 'https://example.org/policies/test-policy-updated',
      publishedAt: '2025-01-01',
    })
    assert.notEqual(replacement.versionId, first.versionId)
    assert.deepEqual(library.lexical('教育'), [])
    assert.equal(library.current(document.id), first.versionId)
    library.publish(replacement.versionId, first.versionId)
    assert.equal(library.current(document.id), replacement.versionId)
    assert.equal(library.count(), 1)
    assert.deepEqual(library.lexical('养老'), [])
    assert.deepEqual(library.activePassages(firstMatches), [])
    assert.deepEqual(library.passage(citation.id), citation)
    const replacementMatches = library.lexical('教育')
    assert.ok(replacementMatches.length > 0)
    assert.ok(
      library
        .activePassages(replacementMatches)
        .every((passage) => passage.versionId === replacement.versionId),
    )

    assert.throws(() => library.publish(pending.versionId, first.versionId), { status: 409 })
    assert.equal(library.current(document.id), replacement.versionId)
    assert.deepEqual(library.lexical('教育'), replacementMatches)
    assert.deepEqual(library.lexical('住房'), [])
    for (const chunk of pending.chunks)
      assert.throws(() => library.passage(chunk.id), { status: 404 })
    assert.deepEqual(library.passage(citation.id), citation)
    library.publish(replacement.versionId, replacement.versionId)

    store.close()
    store = new Store(root)
    library = new LibraryStore(store)
    assert.equal(library.current(document.id), replacement.versionId)
    assert.equal(library.count(), 1)
    assert.deepEqual(library.lexical('教育'), replacementMatches)
    assert.deepEqual(library.lexical('养老'), [])
    assert.deepEqual(library.passage(citation.id), citation)
    assert.deepEqual(library.stage(document), first)
    for (const chunk of pending.chunks)
      assert.throws(() => library.passage(chunk.id), { status: 404 })

    // The conflicting draft can be retried against the latest published version.
    library.publish(pending.versionId, replacement.versionId)
    assert.equal(library.current(document.id), pending.versionId)
    assert.ok(library.lexical('住房').length > 0)
    assert.deepEqual(library.lexical('教育'), [])
    assert.deepEqual(library.passage(citation.id), citation)
    assert.equal(library.passage(replacementMatches[0]).versionId, replacement.versionId)
  } finally {
    store.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    assert.ok(basename(root).startsWith('gczy-rag-store-test-'))
    await rm(root, { recursive: true })
  }
})

test('Chinese two-character search treats FTS punctuation and operators as query text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gczy-rag-search-test-'))
  const store = new Store(root)
  const library = new LibraryStore(store)
  try {
    const first = library.stage(document)
    library.publish(first.versionId, null)
    const other = library.stage({
      id: 'other-test-policy',
      title: '独立测试文件',
      text: '第一条 住房保障用于自动化测试。',
    })
    library.publish(other.versionId, null)
    const matches = library.lexical('养老')
    assert.ok(matches.length > 0)
    assert.ok(matches.every((id) => library.passage(id).documentId === document.id))
    assert.deepEqual(library.lexical('养老"*:-(()) AND NEAR OR NOT \''), matches)
    assert.deepEqual(library.lexical('养老 AND unlikely_missing_term'), matches)
    assert.deepEqual(library.lexical("养老'); DROP TABLE rag_documents; --"), matches)
    assert.deepEqual(library.lexical('养老 养老 养老'), matches)
    assert.deepEqual(library.lexical(''), [])
    assert.deepEqual(library.lexical(' () : * " - '), [])
    assert.deepEqual(library.lexical('unlikely_missing_term'), [])
    assert.equal(library.lexical('自动化', 1).length, 1)
    for (const query of ['甲'.repeat(8001), '\ud800'])
      assert.throws(() => library.lexical(query), { status: 400 })
    for (const limit of [-1, 0, 101, 1.5, NaN]) {
      assert.throws(() => library.lexical('养老', limit), { status: 400 })
      assert.throws(() => library.list(limit), { status: 400 })
    }
    assert.throws(() => library.list(10, -1), { status: 400 })
    assert.throws(() => library.activePassages(Array(257).fill('id')), { status: 400 })
    assert.equal(library.count(), 2)
    const housing = library.lexical('住房')
    assert.ok(housing.length > 0)
    assert.ok(housing.every((id) => library.passage(id).documentId === 'other-test-policy'))
  } finally {
    store.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    assert.ok(basename(root).startsWith('gczy-rag-search-test-'))
    await rm(root, { recursive: true })
  }
})
