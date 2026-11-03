import type { ValsetJob, ValsetJobSummary } from '@/types/valset'
import { request } from './research'

export const listValsetJobs = (signal?: AbortSignal) =>
  request<ValsetJobSummary[]>('/valset/jobs', { signal })

export const readValsetJob = (id: string, signal?: AbortSignal) =>
  request<ValsetJob>(`/valset/jobs/${id}`, { signal })

export function startValsetJob(file: File) {
  const form = new FormData()
  form.append('file', file)
  return request<ValsetJob>('/valset/jobs', { method: 'POST', body: form })
}

export const cancelValsetJob = (id: string) =>
  request<ValsetJob>(`/valset/jobs/${id}/cancel`, { method: 'POST' })

/** 下载链接：浏览器直接带登录态下载 */
export const VALSET_TEMPLATE_URL = '/api/valset/template'
export const valsetExportUrl = (id: string) => `/api/valset/jobs/${id}/export`
