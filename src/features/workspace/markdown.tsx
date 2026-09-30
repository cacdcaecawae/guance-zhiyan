import { useId } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { passagePath } from './citations'

// U+2060 keeps a citation badge on the line of the word it follows; an inline-block can wrap alone.
const WORD_JOINER = String.fromCodePoint(0x2060)

type MarkdownNode = { type: string; identifier?: string; children?: MarkdownNode[] }
// Label "a-2" must not collide with the converter's second reference to label "a".
// Encode case-folded labels without hyphens; the converter still owns all footnote rules.
const remarkFootnoteIds = () => {
  const visit = (node: MarkdownNode) => {
    if (node.type === 'footnoteDefinition' || node.type === 'footnoteReference')
      node.identifier = Array.from(node.identifier!.toUpperCase(), (char) =>
        char.codePointAt(0)!.toString(16),
      ).join('_')
    node.children?.forEach(visit)
  }
  return visit
}

/**
 * Raw HTML is ignored; only HTTP(S), exact library paths and generated local footnotes navigate.
 * Library citations render as superscript numbers from citations, the answer-wide order of
 * server-checked passages (citationOrder); without it, as in file previews, they stay text.
 */
export function Markdown({ text, citations }: { text: string; citations?: readonly string[] }) {
  const footnotePrefix = `user-content-${useId()}-`
  const footnoteLabel = footnotePrefix + 'footnote-label'
  return (
    <div className="answer-markdown min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFootnoteIds]}
        remarkRehypeOptions={{
          clobberPrefix: footnotePrefix,
          footnoteLabel: '脚注',
          footnoteBackLabel: (index, reference) =>
            `返回脚注 ${index + 1}${reference > 1 ? `（第 ${reference} 处引用）` : ''}`,
        }}
        skipHtml
        urlTransform={(url, _key, node) =>
          /^https?:\/\//i.test(url) ||
          passagePath.test(url) ||
          ((node.properties.dataFootnoteRef ||
            Object.hasOwn(node.properties, 'dataFootnoteBackref')) &&
            url.startsWith('#' + footnotePrefix))
            ? url
            : ''
        }
        components={{
          a: ({ node, href, children, ...props }) => {
            if (!href) return <span>{children}</span>
            const reference = node?.properties.dataFootnoteRef === true
            if (reference || (node && Object.hasOwn(node.properties, 'dataFootnoteBackref')))
              return (
                <a
                  {...props}
                  href={href}
                  aria-label={reference ? `脚注 ${children}` : props['aria-label']}
                  aria-describedby={reference ? footnoteLabel : undefined}
                  className="rounded-sm text-brand underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(event) => {
                    // Keep this local: hash navigation would remount the workspace and lose drafts.
                    event.preventDefault()
                    const target = document.getElementById(href.slice(1))
                    target?.scrollIntoView({ block: 'nearest' })
                    target?.focus({ preventScroll: true })
                  }}
                >
                  {reference && '注 '}
                  {children}
                </a>
              )
            const passage = passagePath.exec(href)
            if (passage) {
              const number = (citations ?? []).indexOf(passage[1].toLowerCase()) + 1
              // A passage path not written literally in the text (e.g. entity-encoded) is not linked.
              if (!number) return <span>{children}</span>
              const badge = (
                <>
                  {WORD_JOINER}
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`原文 ${number}`}
                    title="在新标签页打开原文"
                    className="mx-0.5 rounded-sm bg-tag px-1.5 py-0.5 align-super text-ui-xs leading-none font-medium text-brand no-underline outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {number}
                  </a>
                </>
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
          h2: ({ node: _node, ...props }) => (
            <h2 {...props} id={props.id === 'footnote-label' ? footnoteLabel : props.id} />
          ),
          li: ({ node: _node, ...props }) => (
            <li {...props} tabIndex={props.id?.startsWith(footnotePrefix) ? -1 : undefined} />
          ),
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
