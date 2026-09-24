import type { Session } from '../types/index.ts'

export interface SessionChange {
  path: (string | number)[]
  value?: unknown
  append?: string
  remove?: true
}
export type SessionFrame = { snapshot: Session } | { changes: SessionChange[] }

/** Immutable snapshots share history; unchanged branches are skipped by identity. */
export function sessionChanges(previous: Session, next: Session): SessionChange[] {
  const changes: SessionChange[] = []
  const visit = (before: unknown, after: unknown, path: (string | number)[]) => {
    if (before === after) return
    if (typeof before === 'string' && typeof after === 'string' && after.startsWith(before)) {
      changes.push({ path, append: after.slice(before.length) })
    } else if (Array.isArray(before) && Array.isArray(after)) {
      after.forEach((value, index) => visit(before[index], value, [...path, index]))
      if (after.length < before.length)
        changes.push({ path: [...path, 'length'], value: after.length })
    } else if (
      before &&
      after &&
      typeof before === 'object' &&
      typeof after === 'object' &&
      !Array.isArray(before) &&
      !Array.isArray(after)
    ) {
      const old = before as Record<string, unknown>,
        current = after as Record<string, unknown>
      for (const key of Object.keys(old))
        if (!Object.hasOwn(current, key)) changes.push({ path: [...path, key], remove: true })
      for (const key of Object.keys(current)) visit(old[key], current[key], [...path, key])
    } else changes.push({ path, value: after })
  }
  visit(previous, next, [])
  return changes
}

export function applySessionFrame(current: Session | null, frame: SessionFrame): Session {
  if ('snapshot' in frame) return frame.snapshot
  if (!current) throw new Error('Missing stream snapshot')
  const patch = (value: unknown, change: SessionChange, depth = 0): unknown => {
    if (depth === change.path.length)
      return change.append !== undefined ? String(value) + change.append : change.value
    const key = change.path[depth]
    if (['__proto__', 'constructor', 'prototype'].includes(String(key)))
      throw new Error('Invalid stream path')
    const copy = (Array.isArray(value) ? [...value] : { ...(value as object) }) as Record<
      string | number,
      unknown
    >
    if (change.remove && depth === change.path.length - 1) delete copy[key]
    else copy[key] = patch(copy[key], change, depth + 1)
    return copy
  }
  return frame.changes.reduce((session, change) => patch(session, change) as Session, current)
}
