import { SendHorizontalIcon, SquareIcon } from 'lucide-react'
import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Textarea } from '@/components/ui/textarea'
import { readPref, writePref } from '@/lib/storage'

const HEIGHT_KEY = 'gczy.composer-height'
const HEIGHT = { min: 48, max: 480 }

interface ComposerProps {
  onSubmit: (question: string) => boolean | void | Promise<boolean | void>
  onStop?: () => void
  /** 上一条回答仍在加载时禁止再次提交 */
  busy?: boolean
  /** 输入框底行左侧的控件，例如模型选择 */
  children?: ReactNode
}

/** 底部输入区：Enter 提交，Shift+Enter 换行，空白内容不可提交。 */
export function Composer({ onSubmit, busy = false, onStop, children }: ComposerProps) {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  // 输入框最小高度：顶部把手拖动或方向键调整，作为界面偏好保存；内容更多时仍自动增高。
  const [height, setHeight] = useState(() => {
    const saved = Number(readPref(HEIGHT_KEY))
    return saved ? Math.min(HEIGHT.max, Math.max(HEIGHT.min, saved)) : HEIGHT.min
  })
  const canSubmit = value.trim().length > 0 && !busy && !sending

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!canSubmit) return
    const draft = value
    setSending(true)
    try {
      if ((await onSubmit(draft.trim())) !== false)
        setValue((current) => (current === draft ? '' : current))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      e.nativeEvent.keyCode !== 229
    ) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <form
      aria-label="提问"
      onSubmit={submit}
      className="group/form relative flex flex-col gap-1 rounded-xl border border-input-border bg-input p-2 shadow-sm transition-colors hover:border-input-border-hover focus-within:border-input-border-focused"
    >
      <ResizeHandle
        orientation="horizontal"
        invert
        label="调整输入框高度"
        value={height}
        min={HEIGHT.min}
        max={HEIGHT.max}
        onChange={(next) => {
          setHeight(next)
          writePref(HEIGHT_KEY, String(next))
        }}
        className="group/grip absolute inset-x-0 -top-1.5 flex h-3 justify-center rounded-t-xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -top-0.5 left-1/2 h-1 w-8 -translate-x-1/2 rounded-sm bg-border-hover opacity-0 transition-opacity group-hover/form:opacity-100"
      />
      <Textarea
        aria-label="研究问题"
        placeholder="提出一个研究问题…"
        rows={2}
        maxLength={8000}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        style={{ minHeight: height, maxHeight: Math.max(height, 240) }}
        className="border-0 bg-transparent px-1 py-1 field-sizing-content hover:border-0 focus-visible:bg-transparent"
      />
      <div className="flex min-w-0 items-center gap-2">
        {children}
        {onStop ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="停止生成"
            onClick={onStop}
            className="ml-auto h-8 rounded-md border-brand/50 text-brand hover:text-brand"
          >
            <SquareIcon className="size-3 fill-current" />
            停止
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            aria-label="发送"
            disabled={!canSubmit}
            className="ml-auto rounded-md disabled:bg-tag disabled:text-foreground-subtlest disabled:opacity-100"
          >
            <SendHorizontalIcon />
          </Button>
        )}
      </div>
    </form>
  )
}
