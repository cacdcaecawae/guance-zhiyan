import { SendHorizontalIcon, SquareIcon } from 'lucide-react'
import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Textarea } from '@/components/ui/textarea'
import { readPref, writePref } from '@/lib/storage'

const HEIGHT_KEY = 'gczy.composer-height'
const HEIGHT = { min: 32, max: 480 }

interface ComposerProps {
  onSubmit: (question: string) => boolean | void | Promise<boolean | void>
  onStop?: () => void
  /** 上一条回答仍在加载时禁止再次提交 */
  busy?: boolean
  /** 输入框外右下方的控件，例如模型选择 */
  children?: ReactNode
  /** 新建研究后直接聚焦输入框 */
  autoFocus?: boolean
}

/** 底部输入区：Enter 提交，Shift+Enter 换行，空白内容不可提交。 */
export function Composer({ onSubmit, busy = false, onStop, children, autoFocus }: ComposerProps) {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  // 输入框最小高度：顶部把手拖动或方向键调整，作为界面偏好保存；内容更多时仍自动增高。
  const [height, setHeight] = useState(() => {
    const saved = Number(readPref(HEIGHT_KEY))
    return saved ? Math.min(HEIGHT.max, Math.max(HEIGHT.min, saved)) : HEIGHT.min
  })
  const canSubmit = value.trim().length > 0 && !busy && !sending
  const box = useRef<HTMLTextAreaElement>(null)

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
    <div>
      {/* 参照 Claude：单行圆角输入框，发送键在框内右侧；模型下拉在框外右下方 */}
      <form
        aria-label="提问"
        onSubmit={submit}
        className="group/form relative flex items-end gap-2 rounded-2xl border border-input-border bg-input py-2 pr-2 pl-4 shadow-sm transition-colors hover:border-input-border-hover focus-within:border-input-border-focused"
      >
        <Textarea
          ref={box}
          aria-label="研究问题"
          autoFocus={autoFocus}
          placeholder="提出一个研究问题…"
          rows={1}
          maxLength={8000}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          // 高度按视口封顶，矮屏或放大时输入框不会顶出顶栏
          style={{
            minHeight: `min(${height}px, 40dvh)`,
            maxHeight: `min(${Math.max(height, 240)}px, 50dvh)`,
          }}
          className="flex-1 border-0 bg-transparent px-0 py-1 text-ui-prose field-sizing-content hover:border-0 focus-visible:bg-transparent"
        />
        <ResizeHandle
          orientation="horizontal"
          invert
          label="调整输入框高度"
          measure={() => box.current?.getBoundingClientRect().height ?? height}
          value={height}
          min={HEIGHT.min}
          max={HEIGHT.max}
          onChange={(next) => {
            setHeight(next)
            writePref(HEIGHT_KEY, String(next))
          }}
          className="group/grip absolute inset-x-0 -top-1.5 flex h-3 justify-center rounded-t-2xl"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute -top-0.5 left-1/2 h-1 w-8 -translate-x-1/2 rounded-sm bg-border-hover opacity-0 transition-opacity group-hover/form:opacity-100"
        />
        {onStop ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="停止生成"
            onClick={onStop}
            className="h-8 shrink-0 rounded-lg border-brand/50 text-brand hover:text-brand"
          >
            <SquareIcon className="size-3 fill-current" />
            停止
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            aria-label="发送"
            aria-disabled={!canSubmit}
            className="size-8 shrink-0 rounded-lg aria-disabled:bg-tag aria-disabled:text-foreground-subtlest aria-disabled:opacity-100"
          >
            <SendHorizontalIcon />
          </Button>
        )}
      </form>
      {children && <div className="mt-1.5 flex justify-end px-2">{children}</div>}
    </div>
  )
}
