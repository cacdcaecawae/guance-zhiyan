import type { LibraryDocument, LibraryDocumentSummary, LibraryHit, LibraryPassage } from '@/types'
import { request } from './research'

export const LIBRARY_PAGE_SIZE = 50

export const listDocuments = (title: string, page: number, signal?: AbortSignal) =>
  request<{ total: number; documents: LibraryDocumentSummary[] }>(
    `/library?${new URLSearchParams({
      ...(title && { q: title }),
      limit: String(LIBRARY_PAGE_SIZE),
      offset: String(page * LIBRARY_PAGE_SIZE),
    })}`,
    { signal },
  )

export const readDocument = (id: string, signal?: AbortSignal) =>
  request<LibraryDocument>(`/library/document?${new URLSearchParams({ id })}`, { signal })

export const readPassage = (id: string, signal?: AbortSignal) =>
  request<LibraryPassage>(`/library/passages/${id}?format=json`, { signal })

export const searchPassages = (query: string, signal?: AbortSignal) =>
  request<{ passages: LibraryHit[] }>(`/library/search?${new URLSearchParams({ q: query })}`, {
    signal,
  })
