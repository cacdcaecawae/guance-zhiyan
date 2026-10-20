import { useContext } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { OpenPassage, passagePath } from './citations'

// U+2060 keeps a citation badge or footnote marker on the line of the word it follows; an
// inline-block can wrap alone, and CJK text may break inside “注1”.
const WORD_JOINER = String.fromCodePoint(0x2060)

/**
 * Raw HTML is ignored; only HTTP(S) links and exact library citation paths are navigable, so
 * footnotes don't jump: markers read “注n” so they aren't taken for citation badges, and the
 * back arrows, which could do nothing, are dropped.
 * Library citations render as superscript numbers from citations, the answer-wide order of
 * server-checked passages (citationOrder); without it, as in file previews, they stay text.
 */
export function Markdown({ text, citations }: { text: string; citations?: readonly string[] }) {
  const openPassage = useContext(OpenPassage)
  return (
    <div className="answer-markdown min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Heading of the footnote list; visually hidden, read by screen readers.
        remarkRehypeOptions={{ footnoteLabel: '脚注' }}
        skipHtml
        urlTransform={(url) => (/^https?:\/\//i.test(url) || passagePath.test(url) ? url : '')}
        components={{
          a: ({ href, children, node }) => {
            if (node?.properties.dataFootnoteBackref !== undefined) return null
            if (node?.properties.dataFootnoteRef)
              return (
                <>
                  {WORD_JOINER}注{WORD_JOINER}
                  {children}
                </>
              )
            if (!href) return <span>{children}</span>
            const passage = passagePath.exec(href)
            if (passage) {
              const number = (citations ?? []).indexOf(passage[1].toLowerCase()) + 1
              // A passage path not written literally in the text (e.g. entity-encoded) is not linked.
              if (!number) return <span>{children}</span>
              // “原文”“原文 3”及检索结果 cite 的“planid 文献编号·原文”只显示编号，文献编号放进悬停提示
              const label =
                typeof children === 'string'
                  ? /^(?:planid\s*(\S+?)\s*·\s*)?原文\s*\d*$/.exec(children.trim())
                  : null
              const badge = (
                <>
                  {WORD_JOINER}
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`原文 ${number}`}
                    title={`${label?.[1] ? `文献编号 ${label[1]}，` : ''}${openPassage ? '查看原文' : '在新标签页打开原文'}`}
                    onClick={(event) => {
                      if (
                        !openPassage ||
                        event.button !== 0 ||
                        event.ctrlKey ||
                        event.metaKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return
                      event.preventDefault()
                      openPassage(passage[1].toLowerCase())
                    }}
                    className="mx-0.5 rounded-sm bg-tag px-1.5 py-0.5 align-super text-ui-xs leading-none font-medium text-brand no-underline outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {number}
                  </a>
                </>
              )
              // A descriptive label stays as text before the number.
              return label ? (
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
