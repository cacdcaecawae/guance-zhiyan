const PASSAGE = '/api/library/passages/([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})'
export const passagePath = new RegExp(`^${PASSAGE}$`)
const passageInText = new RegExp(PASSAGE, 'g')

/** Library passages of one answer (thinking and text), numbered by first appearance. */
export function citationOrder(texts: string[]) {
  return [
    ...new Set(
      texts.flatMap((text) =>
        [...text.matchAll(passageInText)].map((match) => match[1].toLowerCase()),
      ),
    ),
  ]
}
