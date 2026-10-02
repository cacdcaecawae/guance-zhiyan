import {
  FileIcon,
  ImagePlusIcon,
  PlusIcon,
  SendHorizontalIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react'
import {
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Textarea } from '@/components/ui/textarea'
import { readPref, writePref } from '@/lib/storage'

const HEIGHT_KEY = 'gczy.composer-height'
const HEIGHT = { min: 32, max: 480 }
// 与后端附件服务支持的格式一致；数量与大小由后端校验并给出原因
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 待发送图片的缩略图；对象 URL 随图片元素创建与释放。 */
function Thumbnail({ file }: { file: File }) {
  const attach = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img) return
      const url = URL.createObjectURL(file)
      img.src = url
      return () => URL.revokeObjectURL(url)
    },
    [file],
  )
  return (
    <img
      ref={attach}
      alt={file.name}
      className="size-14 rounded-lg border border-card-border bg-card object-cover"
    />
  )
}

interface ComposerProps {
  onSubmit: (question: string, images: File[]) => boolean | void | Promise<boolean | void>
  onStop?: () => void
  /** 上一条回答仍在加载时禁止再次提交 */
  busy?: boolean
  /** 输入框外右下方的控件，例如模型选择 */
  children?: ReactNode
  /** 新建研究后直接聚焦输入框 */
  autoFocus?: boolean
}

/** 底部输入区：Enter 提交，Shift+Enter 换行；可选图片、粘贴或拖入图片，没有文字也没有图片时不可提交。 */
export function Composer({ onSubmit, busy = false, onStop, children, autoFocus }: ComposerProps) {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<File[]>([])
  const [notice, setNotice] = useState('')
  const [sending, setSending] = useState(false)
  // 输入框最小高度：顶部把手拖动或方向键调整，作为界面偏好保存；内容更多时仍自动增高。
  const [height, setHeight] = useState(() => {
    const saved = Number(readPref(HEIGHT_KEY))
    return saved ? Math.min(HEIGHT.max, Math.max(HEIGHT.min, saved)) : HEIGHT.min
  })
  const canSubmit = (value.trim().length > 0 || images.length > 0) && !busy && !sending
  const box = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  const addImages = (files: FileList | null) => {
    const list = [...(files ?? [])]
    const accepted = list.filter((file) => IMAGE_TYPES.includes(file.type))
    setNotice(
      accepted.length < list.length
        ? '仅支持 PNG、JPEG、WebP 和 GIF 图片，PDF 等文件敬请期待。'
        : '',
    )
    setImages((current) => [...current, ...accepted])
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!canSubmit) return
    const draft = value
    const draftImages = images
    setSending(true)
    try {
      if ((await onSubmit(draft.trim(), draftImages)) !== false) {
        setValue((current) => (current === draft ? '' : current))
        // 只移除这次发出的图片，等待期间新加的留给下一条
        setImages((current) => current.filter((file) => !draftImages.includes(file)))
        setNotice('')
      }
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
      {/* 参照 Claude：单行圆角输入框，待发送图片在框内上方，添加图片键在左、发送键在右；模型下拉在框外右下方 */}
      <form
        aria-label="提问"
        onSubmit={submit}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          addImages(e.dataTransfer.files)
        }}
        className="group/form relative flex flex-col gap-2 rounded-2xl border border-input-border bg-input p-2 shadow-sm transition-colors hover:border-input-border-hover focus-within:border-input-border-focused"
      >
        {images.length > 0 && (
          <ul aria-label="待发送图片" className="flex flex-wrap gap-2 px-1 pt-1">
            {images.map((file, index) => (
              <li key={index} className="relative">
                <Thumbnail file={file} />
                <button
                  type="button"
                  aria-label={`移除图片 ${file.name}`}
                  title="移除"
                  onClick={() => {
                    setImages((current) => current.filter((item) => item !== file))
                    box.current?.focus()
                  }}
                  className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-sm border border-popover-border bg-popover text-foreground-subtle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          {/* 参照 Claude 的“+”入口；文件附件尚未上线，菜单里明确写“敬请期待” */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="添加图片或文件"
                title="添加图片或文件"
                className="size-8 shrink-0 rounded-lg text-foreground-subtle data-[state=open]:bg-hover data-[state=open]:text-foreground"
              >
                <PlusIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-44">
              <DropdownMenuItem onSelect={() => picker.current?.click()}>
                <ImagePlusIcon />
                添加图片
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <FileIcon />
                添加文件（敬请期待）
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={picker}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            multiple
            hidden
            aria-label="选择图片"
            onChange={(e) => {
              addImages(e.target.files)
              e.target.value = ''
            }}
          />
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
            onPaste={(e) => {
              // 从 Word 等处复制时剪贴板同时带文字和整段截图，只在没有文字时取图片
              if (!e.clipboardData.files.length || e.clipboardData.getData('text/plain')) return
              e.preventDefault()
              addImages(e.clipboardData.files)
            }}
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
            onChange={setHeight}
            onCommit={(next) => writePref(HEIGHT_KEY, String(next))}
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
        </div>
      </form>
      {(children || notice) && (
        <div className="mt-1.5 flex items-start gap-2 px-2">
          {notice && (
            <p role="alert" className="min-w-0 text-ui-sm text-destructive">
              {notice}
            </p>
          )}
          <div className="ml-auto shrink-0">{children}</div>
        </div>
      )}
    </div>
  )
}
