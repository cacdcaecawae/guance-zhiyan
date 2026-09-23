import { sampleQuestions } from '@/services/research'

interface WelcomeProps {
  onPick: (question: string) => void
}

/** 空白会话的欢迎状态：说明范围，给出示例问题与可复现的演示场景。 */
export function Welcome({ onPick }: WelcomeProps) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 py-10">
      <div>
        <h2 className="text-ui-xl font-semibold">开始一项研究</h2>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          围绕政策文本提出问题，回答中的引用可以点击查看对应原文片段。当前为演示模式，回答与文献均为虚构占位内容。
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
      <div className="text-ui-sm text-foreground-subtlest">
        演示场景：问题中包含“演示空结果”会返回空内容，包含“演示失败”会触发失败与重试。
      </div>
    </div>
  )
}
