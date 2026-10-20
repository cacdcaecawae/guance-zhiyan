import { useEffect, useEffectEvent, useState } from 'react'

export type Loaded<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; value: T }

/** 按 key 读取数据；key 变化或重试时重新读取并取消旧请求，旧结果不会显示在新 key 上。 */
export function useRequest<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ id: string; loaded: Loaded<T> }>()
  const id = `${attempt}\n${key}`
  const run = useEffectEvent(load)
  useEffect(() => {
    const abort = new AbortController()
    run(abort.signal).then(
      (value) => setResult({ id, loaded: { status: 'done', value } }),
      (failure: unknown) => {
        if (!abort.signal.aborted)
          setResult({
            id,
            loaded: {
              status: 'error',
              message: failure instanceof Error ? failure.message : '读取失败，请重试。',
            },
          })
      },
    )
    return () => abort.abort()
  }, [id])
  const loaded: Loaded<T> = result?.id === id ? result.loaded : { status: 'loading' }
  return [loaded, () => setAttempt((value) => value + 1)] as const
}
