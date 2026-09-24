const sampleQuestions = [
  '搜索公共政策评估方法，并附上可核对的网页来源。',
  '帮我设计一份政策文本比较表，生成 Excel 文件。',
  '整理一份政策研究报告提纲，生成 Word 文件。',
]

interface WelcomeProps {
  onPick: (question: string) => void
}

/** 空白会话的欢迎状态；示例问题会实际调用后端。 */
export function Welcome({ onPick }: WelcomeProps) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 py-10">
      <div>
        <h2 className="text-ui-xl font-semibold">开始一项研究</h2>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          提出研究问题，按需搜索网页、整理资料并生成文件。联网来源可点击核对；自有文献库检索尚未实现。
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-ui-sm font-medium text-foreground-subtlest">示例问题</div>
        <ul className="flex flex-col gap-2">
          {sampleQuestions.map((q) => (
            <li key={q}>
              <button
                type="button"
                onClick={() => onPick(q)}
                className="w-full rounded-lg border border-card-border bg-card px-3 py-2 text-left text-ui-base outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                {q}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
