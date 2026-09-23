import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useMediaQuery } from '@/lib/use-media-query'
import { getDocument, getPassage } from '@/services/research'

interface SourcePanelProps {
  passageId: string | null
  onClose: () => void
}

/** 右侧资料面板：宽屏为侧面板，窄屏为抽屉。 */
export function SourcePanel({ passageId, onClose }: SourcePanelProps) {
  const wide = useMediaQuery('(min-width: 1024px)')
  if (!passageId) return null

  if (wide) {
    return (
      <aside
        aria-label="资料面板"
        className="flex w-80 shrink-0 flex-col border-l border-border bg-surface"
      >
        <PanelBody passageId={passageId} onClose={onClose} showClose />
      </aside>
    )
  }
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent title="资料面板">
        <PanelBody passageId={passageId} onClose={onClose} />
      </SheetContent>
    </Sheet>
  )
}

function PanelBody({
  passageId,
  onClose,
  showClose = false,
}: SourcePanelProps & { passageId: string; showClose?: boolean }) {
  const passage = getPassage(passageId)
  const doc = getDocument(passage.documentId)

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-ui-base font-medium">原文片段</h2>
        {showClose && (
          <Button variant="ghost" size="icon-sm" aria-label="关闭资料面板" onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <dl className="flex flex-col gap-3 text-ui-base">
          <div>
            <dt className="text-ui-sm text-foreground-subtlest">文献</dt>
            <dd className="font-medium">{doc.title}</dd>
            <dd className="text-ui-sm text-foreground-subtle">{doc.source}</dd>
          </div>
          <div className="flex gap-6">
            <div>
              <dt className="text-ui-sm text-foreground-subtlest">章节</dt>
              <dd>{passage.section}</dd>
            </div>
            <div>
              <dt className="text-ui-sm text-foreground-subtlest">片段编号</dt>
              <dd className="font-mono">#{passage.index}</dd>
            </div>
          </div>
          <div>
            <dt className="text-ui-sm text-foreground-subtlest">片段内容</dt>
            <dd className="mt-1 rounded-lg bg-background p-3 leading-relaxed">
              <Highlighted text={passage.text} highlight={passage.highlight} />
            </dd>
          </div>
        </dl>
      </div>
    </>
  )
}

function Highlighted({ text, highlight }: { text: string; highlight: string }) {
  const at = text.indexOf(highlight)
  return (
    <>
      {text.slice(0, at)}
      <mark>{highlight}</mark>
      {text.slice(at + highlight.length)}
    </>
  )
}
