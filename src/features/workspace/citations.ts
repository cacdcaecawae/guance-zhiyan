import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'

const PASSAGE = '/api/library/passages/([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})'
export const passagePath = new RegExp(`^${PASSAGE}$`)
const passageInText = new RegExp(PASSAGE, 'g')
// Match <Markdown>'s conversion: only rendered links count, with footnotes moved to the end.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkRehype)

type Node = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: Node[]
}
const walk = (node: Node, visit: (node: Node) => void) => {
  visit(node)
  node.children?.forEach((child) => walk(child, visit))
}

/**
 * Library passages of one answer (thinking and text), numbered by first appearance as a rendered
 * link. Only passages written literally somewhere in the answer count: the server checks the raw
 * text, so a path that appears only encoded or escaped was never checked.
 */
export function citationOrder(texts: string[]) {
  const checked = new Set(
    texts.flatMap((text) =>
      [...text.matchAll(passageInText)].map((match) => match[1].toLowerCase()),
    ),
  )
  const order = new Set<string>()
  if (!checked.size) return []
  for (const text of texts) {
    const tree = parser.runSync(parser.parse(text))
    walk(tree, (node) => {
      const url = node.type === 'element' && node.tagName === 'a' && node.properties?.href
      const id = typeof url === 'string' && passagePath.exec(url)?.[1].toLowerCase()
      if (id && checked.has(id)) order.add(id)
    })
  }
  return [...order]
}
