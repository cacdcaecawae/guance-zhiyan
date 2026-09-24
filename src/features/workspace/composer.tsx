import { SendHorizontalIcon, SquareIcon } from 'lucide-react'
import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

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
      className="flex flex-col gap-1 rounded-xl border border-input-border bg-input p-2 transition-colors hover:border-input-border-hover focus-within:border-input-border-focused"
    >
      <Textarea
        aria-label="研究问题"
        placeholder="提出一个研究问题…"
        rows={2}
        maxLength={8000}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-60 min-h-0 border-0 bg-transparent px-1 py-1 field-sizing-content hover:border-0 focus-visible:bg-transparent"
      />
      <div className="flex min-w-0 items-center gap-2">
        {children}
        <span className="ml-auto hidden shrink-0 text-ui-sm text-foreground-subtlest md:inline">
          Enter 发送 · Shift+Enter 换行
        </span>
        {onStop ? (
          <Button
            type="button"
            size="icon"
            aria-label="停止生成"
            onClick={onStop}
            className="ml-auto rounded-md md:ml-0"
          >
            <SquareIcon />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            aria-label="发送"
            disabled={!canSubmit}
            className="ml-auto rounded-md disabled:bg-tag disabled:text-foreground-subtlest disabled:opacity-100 md:ml-0"
          >
            <SendHorizontalIcon />
          </Button>
        )}
      </div>
    </form>
  )
}
