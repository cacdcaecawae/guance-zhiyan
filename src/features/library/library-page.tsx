import { SearchIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { TopBar } from '@/app/shell'
import { Button } from '@/components/ui/button'
import { LoadStatus } from '@/components/ui/load-status'
import { headingPath } from '@/features/workspace/citations'
import { useRequest } from '@/lib/use-request'
import { LIBRARY_PAGE_SIZE, listDocuments, searchPassages } from '@/services/library'

const MODES = [
  { id: 'title', label: '按标题', placeholder: '按标题检索，多个词用空格隔开，如：珙县 养老' },
  { id: 'content', label: '按内容', placeholder: '输入问题或要点，如：沧州 化工产业 发展重点' },
] as const

/**
 * 文献库：按标题列出现行文献并分页浏览，或按内容检索原文片段（与模型同一套向量与关键词混合检索）。
 * 检索方式、检索词与页码放在地址里，从文献返回时保持原位。
 */
export function LibraryPage() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const mode = params.get('by') === 'content' ? MODES[1] : MODES[0]
  const query = params.get('q')?.trim() ?? ''
  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1))
  const scroller = useRef<HTMLDivElement>(null)
  const from = location.pathname + location.search
  // 本页表单自己提交的地址；它重绘时不回写表单，免得覆盖重绘期间新输入的文字
  const submitted = useRef<string | null>(null)
  const show = (by: string | null, q: string, page = 1) => {
    submitted.current = `${by === 'content' ? 'content' : 'title'}:${q}`
    setParams({
      ...(by === 'content' && { by }),
      ...(q && { q }),
      ...(page > 1 && { page: String(page) }),
    })
    scroller.current?.scrollTo({ top: 0 })
  }
  // 检索方式与检索词都从表单读取：地址变化后 react-router 以过渡方式重绘，会话很多时要数百毫秒，
  // 重绘前本次渲染的值已过时；单选框与输入框的状态随点击和输入立即更新
  const submit = (form: HTMLFormElement) => {
    const data = new FormData(form)
    show(data.get('by') as string | null, String(data.get('q') ?? '').trim())
  }
  // 其他地址变化（前进 / 后退、侧栏链接）后把表单同步为地址里的值；不靠 key 重建表单，焦点留在原控件上
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (submitted.current === `${mode.id}:${query}`) {
      submitted.current = null
      return
    }
    const fields = form.current!.elements as HTMLFormControlsCollection & {
      by: RadioNodeList
      q: HTMLInputElement
    }
    fields.by.value = mode.id
    fields.q.value = query
  }, [mode.id, query])
  return (
    <>
      <TopBar title="文献库" />
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4">
        <div className="mx-auto flex max-w-[52rem] flex-col gap-4 py-6">
          <form
            ref={form}
            role="search"
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              submit(event.currentTarget)
            }}
          >
            <fieldset className="flex gap-1">
              <legend className="sr-only">检索方式</legend>
              {MODES.map((item) => (
                <label
                  key={item.id}
                  className="flex h-7 cursor-pointer items-center rounded-lg px-2 text-ui-sm text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground has-checked:bg-accent has-checked:font-medium has-checked:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
                >
                  <input
                    type="radio"
                    name="by"
                    value={item.id}
                    defaultChecked={item.id === mode.id}
                    onChange={(event) => submit(event.currentTarget.form!)}
                    className="sr-only"
                  />
                  {item.label}
                </label>
              ))}
            </fieldset>
            <div className="flex gap-2">
              <input
                name="q"
                type="search"
                defaultValue={query}
                aria-label="检索词"
                placeholder={mode.placeholder}
                maxLength={500}
                className="h-8 w-full min-w-0 rounded-lg border border-input-border bg-input px-3 text-ui-base text-foreground outline-none transition-colors placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused"
              />
              <Button type="submit" variant="outline">
                <SearchIcon aria-hidden />
                检索
              </Button>
            </div>
          </form>
          {mode.id === 'title' ? (
            <TitleResults
              title={query}
              page={page}
              from={from}
              onPage={(next) => show(mode.id, query, next)}
            />
          ) : (
            query && <ContentResults query={query} from={from} />
          )}
        </div>
      </div>
    </>
  )
}

/** 摘要只取正文：章节已写在上一行，去掉标题行、Markdown 转义符与多余空白 */
const snippet = (text: string) =>
  text
    .replace(/^#+\s.*$/gm, '')
    .replace(/\\(?=[^\s\w])/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const listLink =
  'rounded-sm outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring'

function TitleResults({
  title,
  page,
  from,
  onPage,
}: {
  title: string
  page: number
  from: string
  onPage: (page: number) => void
}) {
  const [loaded, retry] = useRequest(`${title}\n${page}`, (signal) =>
    listDocuments(title, page - 1, signal),
  )
  if (loaded.status !== 'done')
    return (
      <LoadStatus
        loadingText="正在读取文献…"
        error={loaded.status === 'error' ? loaded.message : undefined}
        onRetry={retry}
      />
    )
  const { total, documents } = loaded.value
  const pages = Math.ceil(total / LIBRARY_PAGE_SIZE)
  return (
    <>
      <p role="status" className="text-ui-caption text-foreground-subtle">
        {title ? `标题含“${title}”的文献共 ${total} 篇` : `共 ${total} 篇文献`}
      </p>
      {documents.length > 0 && (
        <ul className="flex flex-col divide-y divide-border border-y border-border">
          {documents.map((item) => (
            <li key={item.id}>
              <Link
                to={`/library/${encodeURIComponent(item.id)}`}
                state={{ from }}
                className={`flex flex-col gap-0.5 px-2 py-2.5 ${listLink}`}
              >
                <span className="text-ui-base wrap-anywhere">{item.title}</span>
                <span className="text-ui-sm text-foreground-subtlest">
                  文献编号 {item.id}
                  {item.publishedAt && ` · ${item.publishedAt}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <nav aria-label="分页" className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            上一页
          </Button>
          <span className="text-ui-sm text-foreground-subtle">
            第 {page} / {pages} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => onPage(page + 1)}
          >
            下一页
          </Button>
        </nav>
      )}
    </>
  )
}

function ContentResults({ query, from }: { query: string; from: string }) {
  const [loaded, retry] = useRequest(query, (signal) => searchPassages(query, signal))
  if (loaded.status !== 'done')
    return (
      <LoadStatus
        loadingText="正在检索…"
        error={loaded.status === 'error' ? loaded.message : undefined}
        onRetry={retry}
      />
    )
  const hits = loaded.value.passages
  return (
    <>
      <p role="status" className="text-ui-caption text-foreground-subtle">
        {hits.length
          ? `与“${query}”最相关的 ${hits.length} 个片段，按相关度从高到低排列`
          : `没有找到与“${query}”相关的片段`}
      </p>
      {hits.length > 0 && (
        <ol className="flex flex-col divide-y divide-border border-y border-border">
          {hits.map((hit) => (
            <li key={hit.id}>
              <Link
                to={`/library/${encodeURIComponent(hit.documentId)}#${hit.id}`}
                state={{ from }}
                className={`flex flex-col gap-1 px-2 py-3 ${listLink}`}
              >
                <span className="text-ui-base wrap-anywhere">{hit.title}</span>
                <span className="text-ui-sm text-foreground-subtlest wrap-anywhere">
                  文献编号 {hit.documentId} · 片段 {hit.ordinal + 1}
                  {hit.heading && ` · ${headingPath(hit.heading)}`}
                </span>
                <span className="line-clamp-3 text-ui-caption text-foreground-subtle wrap-anywhere">
                  {snippet(hit.text)}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
