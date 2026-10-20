import { createContext, useContext, type ComponentProps } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { OpenPassage, passagePath } from './citations'

// U+2060 keeps a citation badge or footnote marker on the line of the word it follows; an
// inline-block can wrap alone, and CJK text may break inside “注1”.
const WORD_JOINER = String.fromCodePoint(0x2060)

/** The answer-wide citation order (citationOrder) for the links inside one Markdown block. */
const Citations = createContext<readonly string[] | undefined>(undefined)

function Anchor({ href, children, node }: ComponentProps<'a'> & ExtraProps) {
  const citations = useContext(Citations)
  const openPassage = useContext(OpenPassage)
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
    const id = passage[1].toLowerCase()
    const number = (citations ?? []).indexOf(id) + 1
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
          data-passage={id}
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
            openPassage(id, event.currentTarget)
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
}

// Module-level components keep their identity across renders: components created inside render
// are new types each time, so React remounted every link and table, dropping keyboard focus (e.g.
// on a citation whose panel was just opened) and table scroll positions.
const components: Components = {
  a: Anchor,
  img: ({ alt }) => <span>[图片：{alt ?? '未加载'}]</span>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
}
const remarkPlugins = [remarkGfm]
// Heading of the footnote list; visually hidden, read by screen readers.
const remarkRehypeOptions = { footnoteLabel: '脚注' }
const urlTransform = (url: string) =>
  /^https?:\/\//i.test(url) || passagePath.test(url) ? url : ''

/**
 * Raw HTML is ignored; only HTTP(S) links and exact library citation paths are navigable, so
 * footnotes don't jump: markers read “注n” so they aren't taken for citation badges, and the
 * back arrows, which could do nothing, are dropped.
 * Library citations render as superscript numbers from citations, the answer-wide order of
 * server-checked passages (citationOrder); without it, as in file previews, they stay text.
 */
export function Markdown({ text, citations }: { text: string; citations?: readonly string[] }) {
  return (
    <div className="answer-markdown min-w-0">
      <Citations value={citations}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          remarkRehypeOptions={remarkRehypeOptions}
          skipHtml
          urlTransform={urlTransform}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </Citations>
    </div>
  )
}
