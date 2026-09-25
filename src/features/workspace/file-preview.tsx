import { Loader2Icon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { parseCsv } from '@/lib/csv'
import { readPref, writePref } from '@/lib/storage'
import { artifactUrl, readArtifactText } from '@/services/research'
import type { Artifact } from '@/types'
import { Markdown } from './markdown'

const TEXT_FORMATS = new Set(['md', 'markdown', 'csv', 'txt', 'json'])
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
const MAX_TABLE_ROWS = 500

type Loaded =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; text: string }

function Body({ file }: { file: Artifact }) {
  const { id } = file
  const previewable = TEXT_FORMATS.has(file.format) && file.size <= MAX_PREVIEW_BYTES
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!previewable) return
    const abort = new AbortController()
    readArtifactText({ id }, abort.signal).then(
      (text) => setLoaded({ status: 'done', text }),
      (failure: unknown) => {
        if (!abort.signal.aborted)
          setLoaded({
            status: 'error',
            message: failure instanceof Error ? failure.message : '文件读取失败，请重试。',
          })
      },
    )
    return () => abort.abort()
  }, [id, previewable, attempt])

  if (!previewable)
    return (
      <p className="text-ui-caption text-foreground-subtle">
        {TEXT_FORMATS.has(file.format)
          ? '文件较大，请下载后查看。'
          : `${file.format.toUpperCase()} 文件暂不支持在线预览，请下载后查看。`}
      </p>
    )
  if (loaded.status === 'loading')
    return (
      <p role="status" className="flex items-center gap-2 text-ui-caption text-foreground-subtle">
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
        正在读取文件…
      </p>
    )
  if (loaded.status === 'error')
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-ui-caption text-destructive">
          {loaded.message}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoaded({ status: 'loading' })
            setAttempt((value) => value + 1)
          }}
        >
          重试
        </Button>
      </div>
    )
  if (file.format === 'csv') {
    const [head = [], ...rows] = parseCsv(loaded.text)
    return (
      <div className="answer-markdown overflow-x-auto">
        <table>
          <thead>
            <tr>
              {head.map((cell, index) => (
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, MAX_TABLE_ROWS).map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > MAX_TABLE_ROWS && (
          <p className="text-ui-sm text-foreground-subtlest">
            共 {rows.length} 行，此处显示前 {MAX_TABLE_ROWS} 行，完整内容请下载。
          </p>
        )}
      </div>
    )
  }
  if (file.format === 'md' || file.format === 'markdown')
    return (
      <div className="font-serif text-ui-prose">
        <Markdown text={loaded.text} />
      </div>
    )
  return <pre className="font-mono text-ui-sm whitespace-pre-wrap wrap-anywhere">{loaded.text}</pre>
}

/** 右侧文件预览：灰色桌面上的一页纸。文件内容来自模型或工具，按不可信文本渲染。 */
export function FilePreview({ file, onClose }: { file: Artifact; onClose?: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className={`flex h-12 shrink-0 items-center gap-2 border-b border-border pl-4 ${onClose ? 'pr-3' : 'pr-12'}`}
      >
        <span className="min-w-0 flex-1 truncate text-ui-caption font-medium" title={file.name}>
          {file.name}
        </span>
        <Button asChild variant="outline" size="sm" className="rounded-md">
          <a href={artifactUrl(file)}>下载</a>
        </Button>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="关闭预览" onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="document-sheet mx-auto min-w-0 max-w-3xl rounded-sm bg-card px-7 py-8 shadow-sm">
          <Body key={file.id} file={file} />
        </div>
      </div>
    </div>
  )
}

const WIDTH_KEY = 'gczy.preview-width'
const WIDTH = { min: 320, max: 760, initial: 440 }

/** 宽屏右侧的预览栏：左边缘可拖动调整宽度并保存为界面偏好；独立成组件，拖动时不重绘对话。 */
export function PreviewPane({ file, onClose }: { file: Artifact; onClose: () => void }) {
  const [width, setWidth] = useState(() => {
    const saved = Number(readPref(WIDTH_KEY))
    return saved ? Math.min(WIDTH.max, Math.max(WIDTH.min, saved)) : WIDTH.initial
  })
  return (
    <aside
      aria-label="文件预览"
      style={{ width }}
      className="relative shrink-0 border-l border-border"
    >
      <ResizeHandle
        orientation="vertical"
        invert
        label="调整预览宽度"
        value={width}
        min={WIDTH.min}
        max={WIDTH.max}
        onChange={(next) => {
          setWidth(next)
          writePref(WIDTH_KEY, String(next))
        }}
        className="absolute inset-y-0 -left-1 z-10 w-2 transition-colors hover:bg-brand/25 active:bg-brand/40"
      />
      <FilePreview file={file} onClose={onClose} />
    </aside>
  )
}
