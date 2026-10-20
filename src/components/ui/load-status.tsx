import { Loader2Icon } from 'lucide-react'
import { Button } from './button'

/** 读取中与读取失败的统一显示；失败写明原因并提供重试。 */
export function LoadStatus({
  error,
  loadingText,
  onRetry,
}: {
  error?: string
  loadingText: string
  onRetry: () => void
}) {
  if (!error)
    return (
      <p role="status" className="flex items-center gap-2 text-ui-caption text-foreground-subtle">
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
        {loadingText}
      </p>
    )
  return (
    <div className="flex flex-col items-start gap-2">
      <p role="alert" className="text-ui-caption text-destructive">
        {error}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        重试
      </Button>
    </div>
  )
}
