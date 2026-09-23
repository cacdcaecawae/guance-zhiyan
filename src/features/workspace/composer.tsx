import { SendHorizontalIcon } from 'lucide-react'
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface ComposerProps {
  onSubmit: (question: string) => void
  /** 上一条回答仍在加载时禁止再次提交 */
  busy?: boolean
}

/** 底部输入区：Enter 提交，Shift+Enter 换行，空白内容不可提交。 */
export function Composer({ onSubmit, busy = false }: ComposerProps) {
  const [value, setValue] = useState('')
  const canSubmit = value.trim().length > 0 && !busy

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!canSubmit) return
    onSubmit(value.trim())
    setValue('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      e.nativeEvent.keyCode !== 229
    ) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <form
      aria-label="提问"
      onSubmit={submit}
      className="flex items-end gap-2 rounded-xl border border-input-border bg-input p-2 focus-within:border-input-border-focused"
    >
      <Textarea
        aria-label="研究问题"
        placeholder="输入研究问题…"
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-40 min-h-0 border-0 bg-transparent px-1 py-1 field-sizing-content hover:border-0 focus-visible:bg-transparent"
      />
      <Button
        type="submit"
        size="icon"
        aria-label="发送"
        disabled={!canSubmit}
        className="rounded-md"
      >
        <SendHorizontalIcon />
      </Button>
    </form>
  )
}
