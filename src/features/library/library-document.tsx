import { ArrowLeftIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { TopBar } from '@/app/shell'
import { LoadStatus } from '@/components/ui/load-status'
import { headingPath } from '@/features/workspace/citations'
import { Markdown } from '@/features/workspace/markdown'
import { useRequest } from '@/lib/use-request'
import { readDocument } from '@/services/library'

/** 一篇文献的现行版本，按原文顺序列出检索所用的全部片段；地址带 #片段编号 时定位并标出该片段。 */
export function LibraryDocumentPage() {
  const { documentId = '' } = useParams()
  const location = useLocation()
  const back = (location.state as { from?: string } | null)?.from ?? '/library'
  const target = decodeURIComponent(location.hash.slice(1))
  const [loaded, retry] = useRequest(documentId, (signal) => readDocument(documentId, signal))
  useEffect(() => {
    if (loaded.status === 'done' && target)
      document.getElementById(`passage-${target}`)?.scrollIntoView({ block: 'start' })
  }, [loaded.status, target])
  const item = loaded.status === 'done' ? loaded.value : null
  return (
    <>
      <TopBar title={item?.title ?? '文献库'} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <article className="mx-auto flex max-w-[52rem] flex-col gap-4 py-6">
          <Link
            to={back}
            className="flex w-fit items-center gap-1 rounded-sm text-ui-caption text-foreground-subtle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeftIcon className="size-4" aria-hidden />
            返回文献库
          </Link>
          {!item ? (
            <LoadStatus
              loadingText="正在读取文献…"
              error={loaded.status === 'error' ? loaded.message : undefined}
              onRetry={retry}
            />
          ) : (
            <>
              <header className="flex flex-col gap-1.5">
                <h2 className="font-serif text-ui-xl font-bold wrap-anywhere">{item.title}</h2>
                <p className="text-ui-sm text-foreground-subtle">
                  文献编号 {item.id}
                  {item.publishedAt && ` · 发布于 ${item.publishedAt}`} · 共 {item.passages.length}{' '}
                  个片段
                  {item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl) && (
                    <>
                      {' · '}
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-sm text-brand underline decoration-brand/40 underline-offset-2 outline-none hover:decoration-brand focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        原始来源
                      </a>
                    </>
                  )}
                </p>
              </header>
              <ol className="flex flex-col gap-3">
                {item.passages.map((passage) => (
                  <li
                    key={passage.id}
                    id={`passage-${passage.id}`}
                    aria-current={passage.id === target || undefined}
                    className={`scroll-mt-4 rounded-xl border p-4 ${passage.id === target ? 'border-brand bg-accent' : 'border-card-border bg-card'}`}
                  >
                    <p className="mb-2 text-ui-sm text-foreground-subtlest">
                      片段 {passage.ordinal + 1}
                      {passage.heading && ` · ${headingPath(passage.heading)}`}
                    </p>
                    <Markdown text={passage.text} />
                  </li>
                ))}
              </ol>
            </>
          )}
        </article>
      </div>
    </>
  )
}
