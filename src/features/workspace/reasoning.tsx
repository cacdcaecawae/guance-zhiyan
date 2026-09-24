import { useState } from 'react'
import { AtomIcon, ChevronDownIcon } from 'lucide-react'
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
      className="group/reasoning min-w-0 text-foreground-subtle"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md py-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <AtomIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 text-ui-caption">思考过程{running ? ' · 生成中' : ''}</span>
        <span aria-hidden>·</span>
        {!open && <span className="min-w-0 flex-1 truncate text-ui-sm">{summary}</span>}
        <ChevronDownIcon
          className="ml-auto size-3 shrink-0 group-open/reasoning:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="mb-2 ml-5 rounded-md bg-surface-hover p-3 text-ui-caption">
        <Markdown text={text} />
      </div>
    </details>
  )
}
