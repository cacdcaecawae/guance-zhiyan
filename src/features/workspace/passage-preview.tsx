import { XIcon } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import { Button } from '@/components/ui/button'
import { LoadStatus } from '@/components/ui/load-status'
import { documentHref } from '@/features/library/document-href'
import { useRequest } from '@/lib/use-request'
import { readPassage } from '@/services/library'
import { headingPath } from './citations'
import { Markdown } from './markdown'

/** 引用原文侧栏：回答中引用的文献片段，可跳到文献库查看整篇并定位到该片段。 */
export function PassagePreview({ id, onClose }: { id: string; onClose?: () => void }) {
  const [loaded, retry] = useRequest(id, (signal) => readPassage(id, signal))
  const passage = loaded.status === 'done' ? loaded.value : null
  const location = useLocation()
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className={`flex h-12 shrink-0 items-center gap-2 border-b border-border pl-4 ${onClose ? 'pr-3' : 'pr-12'}`}
      >
        <span className="min-w-0 flex-1 truncate text-ui-caption font-medium">原文片段</span>
        {passage && (
          <Button asChild variant="outline" size="sm" className="rounded-md">
            {/* 被替代的旧片段不在现行版本里，只打开整篇，不定位 */}
            {/* 带上当前会话地址，文献页的返回链接回到这里而不是文献库列表 */}
            <Link
              to={documentHref(passage.documentId, passage.superseded ? undefined : passage.id)}
              state={{ from: location.pathname }}
            >
              查看全文
            </Link>
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="关闭原文" onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="document-sheet mx-auto min-w-0 max-w-3xl rounded-sm bg-card px-5 py-8 shadow-sm sm:px-8">
          {!passage ? (
            <LoadStatus
              loadingText="正在读取原文…"
              error={loaded.status === 'error' ? loaded.message : undefined}
              onRetry={retry}
            />
          ) : (
            <article className="flex flex-col gap-3">
              <h2 className="font-serif text-ui-lg font-bold wrap-anywhere">{passage.title}</h2>
              <p className="text-ui-sm text-foreground-subtle">
                文献编号 {passage.documentId} · 片段 {passage.ordinal + 1}
                {passage.heading && ` · ${headingPath(passage.heading)}`}
                {passage.publishedAt && ` · 发布于 ${passage.publishedAt}`}
              </p>
              {passage.superseded && (
                <p className="text-ui-sm font-medium">
                  该文献已更新，此处为引用时的旧版本原文，仅供核对引用。
                </p>
              )}
              <div className="font-serif text-ui-prose">
                <Markdown text={passage.text} />
              </div>
            </article>
          )}
        </div>
      </div>
    </div>
  )
}
