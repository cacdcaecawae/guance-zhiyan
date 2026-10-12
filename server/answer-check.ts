import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '../src/types/index.ts'

/**
 * 答后核对（评测迭代 7）：只改提示词时，模型仍常在自己写的句子里补原文没有的年份、背景，
 * 或把预期性指标写成约束性；回答写完后用同一模型单独对照所引原文找出这些句子，展示时去掉。
 */
const PROMPT = `你是核对员。下面是一个问题、一份回答，以及回答所引用的文献原文片段。
逐句检查回答（包括标题、开头说明、表格单元格和分析），找出含有下列问题的句子：
1. 所引原文中找不到的事实：数字、比例、年份、日期、机构、文件或规划名称、项目、具体措施；
2. 与原文矛盾的说法，例如把预期性指标写成约束性、数字或范围写错、把甲的内容归到乙；
3. 原文以外的背景知识，或对原文没有涉及的地区、时期、文件下的断言。
能由原文得出的比较、归纳不算问题；措辞改写不算问题；引号内照抄的原文不算问题。
只输出一个 JSON 对象：{"remove":["从回答中逐字复制的问题句子"]}；没有问题时输出 {"remove":[]}。`

/** 所引原文合计上限，超出部分不交给核对模型 */
const MAX_SOURCE = 40000

/** 用回答所用的同一模型核对；只返回能在回答中原样找到的句子，模型输出无法解析时视为没有问题。 */
export async function unsupportedSentences(
  llm: LlmRuntime,
  selection: ModelSelection,
  question: string,
  answer: string,
  passages: readonly { documentId: string; text: string }[],
  signal: AbortSignal,
) {
  let budget = MAX_SOURCE
  const sources = passages.flatMap((passage, index) => {
    const text = passage.text.slice(0, budget)
    budget -= text.length
    return text ? [`[原文${index + 1}｜planid ${passage.documentId}]\n${text}`] : []
  })
  const input = ['## 问题', question, '## 回答', answer, '## 所引原文', ...sources].join('\n\n')
  let output = ''
  for await (const chunk of llm.stream({
    ...selection,
    system: PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    maxTokens: 8192,
    signal,
  }))
    if (chunk.type === 'text-delta') output += chunk.text
  let removed: unknown
  try {
    removed = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)).remove
  } catch {
    return []
  }
  if (!Array.isArray(removed)) return []
  return [
    ...new Set(
      removed.filter(
        (sentence): sentence is string =>
          typeof sentence === 'string' && sentence.trim().length >= 6 && answer.includes(sentence),
      ),
    ),
  ]
}

const CITE = /\[[^\]]*\]\(\/api\/library\/passages\/[^)]*\)/g

/** 去掉核对出的句子；因此只剩列表符号、引用链接或标点的行一并去掉，其余行不动。 */
export function withoutSentences(text: string, removed: readonly string[]) {
  return text
    .split('\n')
    .flatMap((line) => {
      let next = line
      for (const sentence of removed) next = next.split(sentence).join('')
      if (next === line) return [line]
      const rest = next.replace(CITE, '').replace(/^\s*\d+[.、)]/, '')
      return /[^\s\-*+>#|。；，、：.]/.test(rest) ? [next] : []
    })
    .join('\n')
}
