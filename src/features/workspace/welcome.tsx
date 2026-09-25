import { Seal } from '@/app/logo'

const sampleQuestions = [
  '搜索公共政策评估方法，并附来源',
  '设计一份政策文本比较表，生成 Excel 文件',
  '整理一份政策研究报告提纲，生成 Word 文件',
]

interface WelcomeProps {
  onPick: (question: string) => void
}

/** 空白会话的欢迎状态，居中排在输入区上方；示例问题会实际调用后端。 */
export function Welcome({ onPick }: WelcomeProps) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-3 py-6 text-center">
      <Seal size={52} />
      <h2 className="mt-1 font-serif text-ui-display font-bold tracking-wider">开始一项研究</h2>
      <p className="text-ui-base text-foreground-subtle">
        提出研究问题，按需搜索网页、整理资料并生成文件。
      </p>
      <ul
        aria-label="示例问题"
        className="mt-3 flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-center"
      >
        {sampleQuestions.map((q) => (
          <li key={q} className="min-w-0">
            <button
              type="button"
              onClick={() => onPick(q)}
              className="w-full rounded-md border border-card-border bg-card px-3 py-1.5 text-left text-ui-caption sm:w-auto sm:text-center text-foreground-subtle outline-none transition-colors hover:border-brand/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
