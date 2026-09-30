import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const PASSAGE = '/api/library/passages/([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})'
export const passagePath = new RegExp(`^${PASSAGE}$`)
const passageInText = new RegExp(PASSAGE, 'g')
// The parser and plugins <Markdown> renders with, so only links that become badges are numbered.
const parser = unified().use(remarkParse).use(remarkGfm)

type Node = { type: string; url?: string; identifier?: string; children?: Node[] }
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
    const tree: Node = parser.parse(text)
    const definitions = new Map<string, string>()
    walk(tree, (node) => {
      if (node.type === 'definition') definitions.set(node.identifier!, node.url!)
    })
    walk(tree, (node) => {
      const url =
        node.type === 'link'
          ? node.url
          : node.type === 'linkReference'
            ? definitions.get(node.identifier!)
            : undefined
      const id = url && passagePath.exec(url)?.[1].toLowerCase()
      if (id && checked.has(id)) order.add(id)
    })
  }
  return [...order]
}
