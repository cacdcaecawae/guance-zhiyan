import { useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { Markdown } from './markdown'

/** Adapted from DSH ReasoningRow (MIT); provenance in THIRD_PARTY_NOTICES.md. */
function latestCompletedParagraphFirstLine(text: string): string {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  while (true) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd =
      nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

export function Reasoning({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState(false)
  const summary = (
    running ? latestCompletedParagraphFirstLine(text) : text.split('\n', 1)[0]
  ).replaceAll('**', '')
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="text-foreground-subtle"
    >
      <summary className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDownIcon className="size-4 shrink-0" aria-hidden />
        <span className="shrink-0 text-ui-caption">思考过程{running ? ' · 生成中' : ''}</span>
        {!open && <span className="truncate text-ui-sm">{summary}</span>}
      </summary>
      <div className="mt-2 border-l border-border pl-3">
        <Markdown text={text} />
      </div>
    </details>
  )
}
