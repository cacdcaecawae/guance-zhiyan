import { Logo } from '@/app/logo'

const sampleQuestions = [
  '搜索公共政策评估方法，并附上可核对的网页来源。',
  '帮我设计一份政策文本比较表，生成 Excel 文件。',
  '整理一份政策研究报告提纲，生成 Word 文件。',
]

interface WelcomeProps {
  onPick: (question: string) => void
}

/** 空白会话的欢迎状态，与输入区一起垂直居中；示例问题会实际调用后端。 */
export function Welcome({ onPick }: WelcomeProps) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 py-6">
      <div className="flex items-start gap-3">
        <Logo className="size-9 shrink-0" />
        <div className="min-w-0">
          <h2 className="font-serif text-ui-xl font-semibold tracking-wide">开始一项研究</h2>
          <p className="mt-1 text-ui-base text-foreground-subtle">
            提出研究问题，按需搜索网页、整理资料并生成文件；联网来源可点击核对。
          </p>
        </div>
      </div>
      <ul aria-label="示例问题" className="flex flex-wrap gap-2">
        {sampleQuestions.map((q) => (
          <li key={q} className="min-w-0">
            <button
              type="button"
              onClick={() => onPick(q)}
              className="rounded-lg border border-card-border bg-card px-3 py-1.5 text-left text-ui-caption text-foreground-subtle outline-none transition-colors hover:border-border-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
