import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  expandAssistantStream,
  type StreamChunk,
  type ContentBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { AnswerPart, AssistantMessage, ImageAttachment, Message } from '../src/types/index.ts'
import { RAG_ERRORS } from './rag.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    'guance-retry': { kind: 'guance-retry'; answerId: string; questionId: string }
  }
}

/** Only the current, not-yet-committed attempt; earlier attempts may share its turn and step. */
export interface LiveAttempt {
  turn: number
  step: number
  chunks: StreamChunk[]
}
const textOf = (content: readonly ContentBlock[]) =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
export const imagesOf = (content: readonly ContentBlock[]) =>
  content.flatMap((block) => (block.type === 'image' ? [block.attachment] : []))

export function toolError(code?: string): string {
  const messages: Record<string, string> = {
    ...RAG_ERRORS,
    ABORTED: '工具执行已中断。',
    ABORTED_BEFORE_DISPATCH: '工具执行已中断。',
    TOOL_TIMEOUT: '工具执行超时，请重试或更换来源。',
    FILE_INVALID_NAME: '文件名称或格式无效。',
    FILE_INVALID_CONTENT: '文件内容为空或超过 200 KB。',
    FILE_INVALID_DOCX_CONTENT: 'Word 正文含有不支持的字符，请移除无效字符或改用 Markdown。',
    FILE_INVALID_XLSX_CONTENT: '表格含有 Excel 不支持的字符，请移除无效字符或改用 CSV。',
    FILE_INVALID_TABLE:
      '表格内容必须为二维 JSON 数组，最多 2000 行、50 列，单元格仅支持文本或数字。',
    FILE_TOO_LARGE: '文件名称无效或文件超过 50 MiB。',
    FILE_QUOTA: '文件空间已达上限，请联系管理员。',
    FILE_SESSION_ONLY: '只能读取当前会话的文件。',
    FILE_WORKSPACE_ONLY: '只能导出当前会话工作区内的文件。',
    FILE_SANDBOX_REQUIRED: '外部生成的 Office 文件需要在会话沙箱中读取，请先配置沙箱服务。',
    FILE_BINARY: '这是二进制文件，请使用沙箱工具处理或下载。',
    SANDBOX_UNAVAILABLE: '执行环境不可用，请检查沙箱服务后重试。',
    FS_NOT_FOUND: '工作区中没有找到该文件，请检查路径。',
    FS_PERMISSION_DENIED: '无法访问该文件，请使用当前会话工作区。',
    FS_TOO_LARGE: '文件超过本次操作支持的大小。',
    WEB_BLOCKED_URL:
      '网页地址被安全检查拦截。若公网域名被本机代理解析为虚拟 IP，请配置后端 HTTP_PROXY / HTTPS_PROXY 后重试。',
    WEB_FETCH_TIMEOUT: '网页读取超时，请重试或更换来源。',
    WEB_PROVIDER_ERROR: '搜索供应商未返回有效结果，请检查平台搜索支持与后端配置后重试。',
    WEB_PROVIDER_CREDENTIAL_MISSING: '搜索供应商密钥未配置，请在后端配置后重试。',
    WEB_UNSUPPORTED_CONTENT_TYPE: '该地址返回的文件类型暂不支持网页读取。',
  }
  return messages[code ?? ''] ?? '工具执行失败，请检查参数、网络或服务配置。'
}

export const toolText = (text: string) =>
  text.length > 16000 ? text.slice(0, 16000) + '\n[内容已截断]' : text
export function toolInput(input: string) {
  if (input.length <= 2000) return input
  const summary: Record<string, unknown> = { _truncated: true }
  try {
    const value = JSON.parse(input)
    for (const key of ['command', 'file_path', 'path', 'url', 'name', 'id'])
      if (typeof value?.[key] === 'string') summary[key] = value[key].slice(0, 160)
    if (Array.isArray(value?.queries))
      summary.queries = value.queries.slice(0, 3).map((item: unknown) => String(item).slice(0, 80))
  } catch {
    /* Invalid tool JSON is displayed as a bounded preview. */
  }
  return JSON.stringify({ ...summary, preview: input.slice(0, 400) })
}

export function appendChunks(
  parts: AnswerPart[],
  chunks: StreamChunk[],
  prefix: string,
  step: number,
) {
  for (const chunk of chunks) {
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') continue
    const id = `${prefix}-${chunk.index}`
    const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
    const part = parts.find((p) => p.id === id)
    if (part && part.type !== 'tool') part.text += chunk.text
    else parts.push({ id, type, text: chunk.text, step })
  }
}

/** Only public message content crosses HTTP; internal headers and credentials never do. */
export function messagesFromEvents(
  events: readonly SessionEvent[],
  running: boolean,
  live?: LiveAttempt,
): Message[] {
  const messages: Message[] = []
  let answer: AssistantMessage | undefined
  let question = ''
  let images: ImageAttachment[] = []
  let turn = 0
  const userIds = new Set<string>()
  let retryAnswerId: string | undefined
  const addUser = (message: UserMessage, pending = false) => {
    const { id, content, source } = message
    question = textOf(content)
    images = imagesOf(content).map(({ attachmentId, name, width, height }) => ({
      id: attachmentId,
      ...(name && { name }),
      width,
      height,
    }))
    const retry = source.kind === 'guance-retry' ? source.answerId : undefined
    if (pending) retryAnswerId = retry
    if (!userIds.has(id) && !retry) {
      messages.push({ id, role: 'user', text: question, ...(images.length && { images }) })
      userIds.add(id)
    }
    if (answer?.status === 'loading') {
      answer.question = question
      answer.questionImages = images
    }
  }
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted)
        if (message.source.kind === 'user' || message.source.kind === 'guance-retry')
          addUser(message, true)
    } else if (event.type === 'user/message') {
      if (event.data.source.kind === 'user' || event.data.source.kind === 'guance-retry')
        addUser(event.data)
    } else if (event.type === 'turn/start') {
      turn = event.data.turn
      answer = {
        id: retryAnswerId ?? `turn-${turn}`,
        ...(retryAnswerId && { attemptId: `turn-${turn}` }),
        role: 'assistant',
        question,
        questionImages: images,
        status: 'loading',
        parts: [],
        startedAt: event.time,
      }
      const previous = retryAnswerId
        ? messages.findIndex((message) => message.id === retryAnswerId)
        : -1
      if (previous >= 0) messages[previous] = answer
      else messages.push(answer)
      retryAnswerId = undefined
    } else if (
      answer &&
      (event.type === 'assistant/message' || event.type === 'assistant/attempt')
    ) {
      appendChunks(
        answer.parts,
        expandAssistantStream(event.data.stream).map((member) => member.chunk),
        `step-${event.data.step}-${event.seq}`,
        event.data.step,
      )
    } else if (answer && event.type === 'tool/call') {
      answer.parts.push({
        id: event.data.callId,
        type: 'tool',
        name: event.data.name,
        input: toolInput(event.data.arguments),
        output: '',
        status: 'running',
      })
    } else if (answer && event.type === 'tool/result') {
      const part = answer.parts.find(
        (p) => p.type === 'tool' && p.id === event.data.message.toolCallId,
      )
      if (part?.type === 'tool') {
        part.status = event.data.message.isError ? 'error' : 'done'
        part.output = event.data.message.isError
          ? toolError(event.data.error?.code)
          : toolText(textOf(event.data.message.content))
      }
    } else if (answer && event.type === 'turn/end') {
      answer.endedAt = event.time
      const reason = event.data.reason
      answer.status =
        reason.kind === 'completed'
          ? 'done'
          : reason.kind === 'aborted' || reason.kind === 'interrupted'
            ? 'stopped'
            : 'error'
      if (answer.status === 'error') {
        answer.error =
          reason.kind === 'max-tokens' ? '回答达到长度上限，已截断。' : '回答生成失败。'
      }
      if (reason.kind === 'aborted' && reason.reason.kind === 'hook')
        answer.error = reason.reason.reason
    }
  }
  if (answer && live && live.turn === turn) {
    appendChunks(answer.parts, live.chunks, `live-${live.step}`, live.step)
  }
  for (const message of messages)
    if (
      message.role === 'assistant' &&
      message.status === 'loading' &&
      (!running || message !== answer)
    ) {
      message.status = 'stopped'
      message.error = '上次生成已中断，可以重新提问。'
    }
  for (const message of messages)
    if (message.role === 'assistant' && message.status !== 'loading') {
      for (const part of message.parts)
        if (part.type === 'tool' && part.status === 'running') {
          // 用户主动停止不算工具失败
          part.status = message.status === 'stopped' ? 'stopped' : 'error'
          part.output = '工具执行已中断。'
        }
    }
  checkCitations(messages)
  trimAnswers(messages)
  return messages
}

const PASSAGE = /\/api\/library\/passages\/([0-9a-fA-F-]{36})/g

/** Passage ids from the structured result lines of a library tool, never from passage text. */
function returnedPassages(output: string) {
  return output.split('\n').flatMap((line) => {
    try {
      const { id, link } = JSON.parse(line)
      return typeof id === 'string' && link === `/api/library/passages/${id}` ? [id] : []
    } catch {
      return [] // Header and notice lines are not JSON.
    }
  })
}

/** An inline link to a library passage; a bare path renders no citation badge, so it does not count. */
const CITED = /\]\(\s*<?\/api\/library\/passages\/[0-9a-fA-F-]{36}/
const ASKS_ANALYSIS =
  /比较|对比|异同|差异|区别|变化|演变|演进|转变|分析|评价|评估|研判|原因|为什么|建议|启示|特点|特征|逻辑|关系|侧重|趋势|研析|(?<!工作)报告/
const HEADING =
  /^(#{1,6})\s|^\*\*[^*]{1,30}\*\*\s*(（[^）]{1,20}）)?\s*$|^[一二三四五六七八九十]+、/
/** A short "label:" in front of an excerpt, such as "**消除碘缺乏病**：", which is not passage text. */
const LABEL = /^(?:[-*+]\s*|\d+[.、]\s*)?(?:\*\*[^*]{1,30}\*\*|[^：:「“"]{1,20})[：:]/
/** Says what the library did not have; such sentences are kept so a trimmed answer never hides a gap. */
const ABSENT =
  /未能?(检索到|找到|查到|收录|涉及)|没有(检索到|找到|收录)|暂未(检索到|收录|找到)|暂无|无正文|没有可用正文/
/**
 * A half-width period ends a sentence too, except after a digit ("12.5", the "1." of a list) and
 * before Latin letters ("规划.pdf").
 */
const SENTENCE = /(?:[^。；;！？!?.]|(?<=\d)\.|\.(?=[A-Za-z]))+[。；;！？!?.]?/g
/** Web sources cited from web tools; the library check cannot judge them. */
const WEB_LINK = /https?:\/\//
/**
 * CJK characters, digits, Latin letters (case-folded) and decimal points between digits, so "5.2"
 * does not match "52" nor "GNP" match "GDP".
 */
const contentChars = (text: string) =>
  text
    .match(/[一-鿿0-9a-zA-Z]|(?<=\d)\.(?=\d)/g)
    ?.join('')
    .toLowerCase() ?? ''
const grams = (text: string) =>
  Array.from({ length: Math.max(0, text.length - 7) }, (_, i) => text.slice(i, i + 8))
/** Full-width digits and decimal point as half-width; one character each, so lengths match. */
const halfWidth = (text: string) =>
  text.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
/** A thousands separator between half- or full-width digits: "10,000", "10，000", "１０,０００". */
const THOUSANDS = /(?<=[0-9０-９])[,，](?=[0-9０-９]{3}(?![0-9０-９]))/g
/**
 * Numbers of two or more digits or with a decimal point; full-width digits, thousands separators
 * and trailing decimal zeros are normalized, so "10,000", "１０，０００" and "10000" are the same
 * number, as are "12.50" and "12.5". Link targets do not count, link text does.
 */
const numbers = (text: string) =>
  (
    halfWidth(text)
      .replace(THOUSANDS, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .match(/\d+(?:\.\d+)?/g) ?? []
  )
    .map((n) => (n.includes('.') ? n.replace(/\.?0+$/, '') : n))
    .filter((n) => n.length >= 2 || n.includes('.'))
/**
 * Counts the model tends to add when summarizing, such as "六大", "七项", "六个方面", "第九章".
 * Compared whole, so "第十九章" in a passage does not support "第九章", nor "一百六十项" "六十项".
 */
const COUNT = /[零〇一二三四五六七八九十百千万两]+个?(?:大|项|方面|章|节|部分|板块|领域)/g
/** A count of the user's own aspects, such as "你关注的三个方面"; "为您说明：共六个方面" is not one. */
const ASKED_COUNT =
  /(?:你|您)[^，。；：:！？]{0,6}的[零〇一二三四五六七八九十百千万两]+个?(?:大|项|方面|章|节|部分|板块|领域)/g
/** Numbers and counts in the library results returned so far and in the questions asked so far. */
type Facts = { runs: Set<string>; numbers: Set<string>; counts: Set<string> }
/**
 * Text giving a number or count found in neither the library results nor the questions, such as
 * "共六个方面", "六大抓手" or "2019年撤市设区".
 */
const unsourced = (text: string, facts: Facts) =>
  numbers(text).some((n) => !facts.numbers.has(n)) ||
  (text.replace(ASKED_COUNT, '').match(COUNT) ?? []).some((count) => !facts.counts.has(count))
/**
 * What to keep of a sentence: all of it, nothing when it is unsourced, or, in a sentence saying what
 * was not found, only its not-found clauses when another clause is unsourced
 * ("未检索到后续资料，但该市2019年撤市设区。" keeps "未检索到后续资料。").
 */
function sourcedPart(sentence: string, facts: Facts) {
  if (!ABSENT.test(sentence)) return unsourced(sentence, facts) ? '' : sentence
  // A thousands separator ("10,000", "１０，０００") is not a clause break.
  const clauses = sentence.match(new RegExp(`(?:[^，,]|${THOUSANDS.source})+[，,]?`, 'g')) ?? []
  if (!clauses.some((clause) => !ABSENT.test(clause) && unsourced(clause, facts))) return sentence
  return clauses
    .filter((clause) => ABSENT.test(clause))
    .join('')
    .replace(/[，,。；;！？!?]?$/, '。')
}

/**
 * Completed answers to factual library questions keep only what the cited passages support:
 * everything before the first cited line (sources, scope, assumptions, what was not found), cited
 * lines, tables containing a citation (rows may omit the outer pipes, as in rag-chunks.ts), lines
 * citing web sources, headings (optionally with a source note), the sentences saying what was not
 * found, and lines that are themselves passage text once a leading "label:" is removed (80% of
 * 8-character runs found in the library results returned up to that answer). Free commentary after
 * the citations (scope notes, summaries, reminders, unrequested analysis sections with their
 * subsections) is dropped: it caused most rejections of factual answers. Replayed on existing answers,
 * the pass rate rose from 49.2% to 55.0% on the 506-document training sample (four rounds, paired CI
 * +2.5 to +8.7) and from 36.3% to 39.7% on the full library (two rounds, CI +1.3 to +6.0), with no
 * category worse. Kept lines without a citation (the opening, headings, passage-text lines) then
 * lose the sentences giving an unsourced number or count, the model's own summaries the judge
 * rejected as information outside the passages: replayed, 55.0% to 56.2% on the 506-document sample
 * (CI +0.2 to +2.2), unchanged on the full library, no category worse. Questions asking for
 * comparison or analysis (a government work report alone does not count), and answers with fewer
 * than two cited lines (refusals, clarifying questions), are left whole. Returns each line as kept
 * (possibly shortened) or undefined when dropped.
 * ponytail: keyword rules; an analysis question without these words is trimmed like a factual one.
 */
function trimAnswer(lines: string[], question: string, facts: Facts) {
  const cited = lines.map((line) => CITED.test(line))
  if (ASKS_ANALYSIS.test(question) || cited.filter(Boolean).length < 2) return lines
  const kept: (string | undefined)[] = lines.map(() => undefined)
  // Table rows, as Markdown reads them: a header line that is not a heading, a separator row
  // ("|---|", "--- | ---"), then the lines with a pipe up to a heading. Each table is found on its
  // own, so a heading with a pipe above, below or between tables is not a row.
  const table = new Set<number>()
  const row = (line: string) => line.includes('|') && !/^\s*#{1,6}\s/.test(line)
  for (let n = 0; n + 1 < lines.length; n++)
    if (row(lines[n]) && /^(?=.*\|)(?=.*-)[\s|:-]+$/.test(lines[n + 1]))
      for (table.add(n); n + 1 < lines.length && row(lines[n + 1]);) table.add(++n)
  for (let start = 0; start < lines.length;) {
    let end = start
    while (end < lines.length && lines[end].includes('|')) end++
    if (end > start && cited.slice(start, end).some(Boolean))
      for (let n = start; n < end; n++) kept[n] = lines[n]
    start = Math.max(end, start + 1)
  }
  const first = cited.indexOf(true)
  let section = 0 // heading depth of an analysis or inference section the question did not ask for
  for (const [index, line] of lines.entries()) {
    const text = line.trim()
    if (kept[index] !== undefined) continue
    if (index < first || cited[index] || !text || WEB_LINK.test(text)) {
      kept[index] = line
      continue
    }
    const heading = HEADING.exec(text)
    if (heading) {
      const depth = heading[1]?.length ?? 6
      if (section && depth > section) continue // a subsection of that section
      section = /分析|推断/.test(text) ? depth : 0
      if (!section) kept[index] = line
      continue
    }
    if (ABSENT.test(text)) {
      kept[index] = text
        .match(SENTENCE)
        ?.filter((sentence) => ABSENT.test(sentence))
        .join('')
      continue
    }
    const runs = grams(contentChars(text.replace(LABEL, '')))
    if (
      !section &&
      runs.length &&
      runs.filter((run) => facts.runs.has(run)).length >= 0.8 * runs.length
    )
      kept[index] = line
  }
  for (const [index, line] of kept.entries()) {
    if (line === undefined || cited[index] || table.has(index) || WEB_LINK.test(line)) continue
    // Structure, not data: heading marks, a bullet, then a list or section number, bold or not
    // ("12.", "12、", "12）", "（12）", "3.2 ", full-width too), but not the "12." of "12.5万".
    const prefix = line.slice(
      0,
      /^\s*(?:#{1,6}\s+|[-*+]\s+)?(?:(?:\*\*)?(?:\d+(?:\.\d+)*(?:\.(?!\d)|[、)）])\s*|\d+(?:\.\d+)+\s+|[（(]\d+[）)]\s*))?/.exec(
        halfWidth(line),
      )?.[0].length,
    )
    // A leading "label:" is checked on its own like a sentence, so the "（五项）" of
    // "**编制原则**（五项）：" does not take the passage text after it, and "未检索到2030年目标：" stays.
    const body = line.slice(prefix.length)
    const label = LABEL.exec(body)?.[0] ?? ''
    const sentences = body.slice(label.length).match(SENTENCE) ?? []
    const rest = sentences.map((sentence) => sourcedPart(sentence, facts)).join('')
    const head = sourcedPart(label, facts)
    if (head === label && rest === sentences.join('')) continue
    const shown = prefix + head + rest
    // Bold a dropped sentence opened or closed is removed rather than shown as a stray "**".
    if (!rest.trim() && !ABSENT.test(head)) kept[index] = undefined
    else kept[index] = (shown.match(/\*\*/g)?.length ?? 0) % 2 ? shown.replaceAll('**', '') : shown
  }
  return kept
}

function addFacts(message: Message, facts: Facts) {
  const add = (text: string) => {
    for (const n of numbers(text)) facts.numbers.add(n)
    for (const count of text.match(COUNT) ?? []) facts.counts.add(count)
  }
  if (message.role === 'user') add(message.text)
  else
    for (const part of message.parts)
      if (part.type === 'tool' && part.name.startsWith('library_') && part.status === 'done')
        for (const line of part.output.split('\n'))
          try {
            const { text, title, heading, documentId } = JSON.parse(line)
            if (typeof text === 'string')
              for (const run of grams(contentChars(text))) facts.runs.add(run)
            add([text, title, heading, documentId].filter((x) => x != null).join(' '))
          } catch {
            // Header and notice lines are not JSON.
          }
}

export function trimAnswers(messages: Message[]) {
  const facts: Facts = { runs: new Set(), numbers: new Set(), counts: new Set() }
  let read = 0 // messages already added to facts
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant' || message.status !== 'done') continue
    // A question in an attached image may ask for analysis the typed text does not show.
    if (message.questionImages?.length) continue
    // Text parts are trimmed as one answer, then each part keeps its own surviving lines.
    const texts = message.parts.filter((part) => part.type === 'text')
    const lines = texts.flatMap((part, partIndex) =>
      part.text.split('\n').map((line) => ({ partIndex, line })),
    )
    if (lines.filter(({ line }) => CITED.test(line)).length < 2) continue
    // Only results returned up to this answer count, so a later turn cannot bring back trimmed lines.
    for (; read <= index; read++) addFacts(messages[read], facts)
    const kept = trimAnswer(
      lines.map(({ line }) => line),
      message.question,
      facts,
    )
    for (const [partIndex, part] of texts.entries())
      part.text = lines
        .flatMap((line, n) =>
          line.partIndex === partIndex && kept[n] !== undefined ? [kept[n]] : [],
        )
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
  }
}

/**
 * A library citation must point to a passage this session's library tools actually returned.
 * Any other passage path in answer or reasoning text (invented, copied from passage text, in any
 * link syntax) is removed, so a link keeps only its label. Idempotent; also applied to streamed
 * snapshots.
 * Earlier messages may be skipped only when already checked against the unchanged history.
 * Their tool results still authorize later citations in the original message/part order.
 */
export function checkCitations(messages: Message[], firstChangedMessage = 0) {
  const returned = new Set<string>()
  for (const [index, message] of messages.entries())
    if (message.role === 'assistant')
      for (const part of message.parts)
        if (part.type === 'tool') {
          if (part.name.startsWith('library_') && part.status === 'done')
            for (const id of returnedPassages(part.output)) returned.add(id.toLowerCase())
        } else if (index >= firstChangedMessage)
          part.text = part.text.replace(PASSAGE, (path, id: string) =>
            returned.has(id.toLowerCase()) ? path : '',
          )
}
