import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const PASSAGE = '/api/library/passages/([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})'
const passagePath = new RegExp(`^${PASSAGE}$`)
const passageInText = new RegExp(PASSAGE, 'g')

/**
 * Raw HTML is ignored; only HTTP(S) links and exact library citation paths are navigable.
 * Library citations render as superscript numbers in order of first appearance.
 */
export function Markdown({ text }: { text: string }) {
  const order = [
    ...new Set([...text.matchAll(passageInText)].map((match) => match[1].toLowerCase())),
  ]
  return (
    <div className="answer-markdown min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (/^https?:\/\//i.test(url) || passagePath.test(url) ? url : '')}
        components={{
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>
            const passage = passagePath.exec(href)
            if (passage) {
              const number = order.indexOf(passage[1].toLowerCase()) + 1
              // A passage path not written literally in the text (e.g. entity-encoded) is not linked.
              if (!number) return <span>{children}</span>
              const badge = (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`原文 ${number}`}
                  title="在新标签页打开原文"
                  className="mx-0.5 inline-block rounded-sm bg-tag px-1.5 py-0.5 align-super text-ui-xs leading-none font-medium text-brand no-underline outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {number}
                </a>
              )
              // “原文”“原文 3” become just the number; a descriptive label stays as text.
              return typeof children === 'string' && /^原文\s*\d*$/.test(children.trim()) ? (
                badge
              ) : (
                <>
                  {children}
                  {badge}
                </>
              )
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-sm text-brand underline decoration-brand/40 underline-offset-2 outline-none transition-colors hover:decoration-brand focus-visible:ring-2 focus-visible:ring-ring"
              >
                {children}
              </a>
            )
          },
          img: ({ alt }) => <span>[图片：{alt ?? '未加载'}]</span>,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
