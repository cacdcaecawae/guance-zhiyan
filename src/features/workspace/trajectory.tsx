import { ChevronDownIcon, Clock3Icon, LayersIcon, ListTreeIcon } from 'lucide-react'
import { useState } from 'react'
import type { TraceEntry } from '@/types'
import { toolNames, toolSummary } from './tool-display'

const kinds = {
  system: { label: '系统', color: 'bg-tag text-foreground-subtle' },
  user: { label: '用户', color: 'bg-accent text-brand' },
  context: { label: '上下文', color: 'bg-trace-context/10 text-trace-context' },
  assistant: { label: '助手', color: 'bg-trace-model/10 text-trace-model' },
  tool: { label: '工具', color: 'bg-trace-tool/10 text-trace-tool' },
}
const duration = (entry: TraceEntry) =>
  entry.end === undefined ? '' : `${((entry.end - entry.time) / 1000).toFixed(2)} s`

export function Trajectory({ entries }: { entries: TraceEntry[] }) {
  const [timed, setTimed] = useState(true)
  const [turnsOpen, setTurnsOpen] = useState(true)
  const [callsOpen, setCallsOpen] = useState(true)
  const turns = [...new Set(entries.map((entry) => entry.turn))]
  const start = Math.min(...entries.map((entry) => entry.time))
  const end = Math.max(...entries.map((entry) => entry.end ?? entry.time))
  const span = Math.max(1, end - start)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-1.5"
        aria-label="轨迹显示选项"
      >
        {[
          { label: '时长', value: timed, set: setTimed, Icon: Clock3Icon },
          { label: '轮次', value: turnsOpen, set: setTurnsOpen, Icon: LayersIcon },
          { label: '调用', value: callsOpen, set: setCallsOpen, Icon: ListTreeIcon },
        ].map(({ label, value, set, Icon }) => (
          <button
            key={label}
            type="button"
            aria-pressed={value}
            onClick={() => set(!value)}
            className={`flex items-center gap-1 rounded-sm px-2 py-1 text-ui-sm outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring ${value ? 'bg-selected text-foreground' : 'text-foreground-subtle'}`}
          >
            <Icon className="size-3" aria-hidden />
            {label}
          </button>
        ))}
        <span className="ml-auto text-ui-sm text-foreground-subtlest">
          {timed ? '记录耗时' : '事件顺序'}
        </span>
      </div>
      {entries.length ? (
        <>
          <div className="shrink-0 border-b border-border px-4 py-3" aria-label="执行时间分布">
            {(['user', 'assistant', 'tool'] as const).map((kind) => (
              <div key={kind} className="flex h-4 items-center gap-2">
                <span className="w-7 shrink-0 text-ui-xs text-foreground-subtlest">
                  {kind === 'user' ? '输入' : kind === 'assistant' ? '模型' : '工具'}
                </span>
                <div className="relative h-2 flex-1 overflow-hidden">
                  {entries.map((entry, index) =>
                    entry.kind !== kind ? null : (
                      <span
                        key={entry.id}
                        title={`${entry.label} · ${entry.status === 'running' ? '执行中' : duration(entry) || '输入'}`}
                        className={`absolute h-2 rounded-sm ${kind === 'assistant' ? 'bg-trace-model' : kind === 'tool' ? 'bg-trace-tool' : 'bg-trace-context'} ${entry.status === 'running' ? 'animate-pulse' : ''}`}
                        style={{
                          left: `${timed ? ((entry.time - start) / span) * 99 : (index / entries.length) * 100}%`,
                          width: `${timed ? Math.max(0.3, (((entry.end ?? entry.time) - entry.time) / span) * 99) : 90 / entries.length}%`,
                        }}
                      />
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" aria-label="执行轨迹">
            {turns.map((turn) => (
              <details key={turn} open={turnsOpen} className="group/turn border-b border-border">
                <summary className="flex cursor-pointer list-none items-center gap-2 bg-surface-hover px-4 py-2 text-ui-sm text-foreground-subtle outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  <ChevronDownIcon
                    className="size-3 shrink-0 group-open/turn:rotate-180"
                    aria-hidden
                  />
                  <span className="shrink-0">第 {turn} 轮</span>
                  <span className="truncate">
                    {entries.find((entry) => entry.turn === turn && entry.kind === 'user')?.text}
                  </span>
                </summary>
                {entries
                  .filter((entry) => entry.turn === turn)
                  .map((entry) => (
                    <details
                      key={entry.id}
                      className={`group/event min-w-0 border-t border-border/50 ${entry.kind === 'tool' && !callsOpen ? 'hidden' : ''}`}
                    >
                      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-3 px-4 py-2 text-ui-caption outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                        <ChevronDownIcon
                          className="size-3 shrink-0 text-foreground-subtlest group-open/event:rotate-180"
                          aria-hidden
                        />
                        <span
                          className={`w-12 shrink-0 rounded-sm px-1 text-center text-ui-sm ${kinds[entry.kind].color}`}
                        >
                          {kinds[entry.kind].label}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {entry.kind === 'tool'
                            ? `${toolNames[entry.label] ?? entry.label} · ${toolSummary(entry.input ?? '')} → ${entry.text}`
                            : entry.text || '等待模型输出…'}
                        </span>
                        {entry.status === 'error' || entry.status === 'stopped' ? (
                          <span className="shrink-0 text-ui-sm text-destructive">
                            {entry.status === 'error' ? '失败' : '已中断'}
                          </span>
                        ) : entry.status === 'running' ? (
                          <span className="shrink-0 text-ui-sm text-foreground-subtle">执行中</span>
                        ) : null}
                        <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                          {duration(entry)}
                        </span>
                      </summary>
                      <div className="mx-4 mb-3 ml-10 rounded-md bg-surface-hover p-3">
                        <p className="mb-2 text-ui-sm text-foreground-subtle">
                          {entry.label} · {new Date(entry.time).toLocaleString('zh-CN')}{' '}
                          {entry.step !== undefined ? `· 步骤 ${entry.step}` : ''}
                        </p>
                        {entry.input !== undefined && (
                          <>
                            <p className="text-ui-sm font-medium">调用参数</p>
                            <pre className="mb-3 max-h-64 overflow-auto text-ui-sm whitespace-pre-wrap wrap-anywhere">
                              {entry.input}
                            </pre>
                          </>
                        )}
                        <pre className="max-h-96 overflow-auto text-ui-sm whitespace-pre-wrap wrap-anywhere">
                          {entry.text || (entry.status === 'running' ? '等待返回…' : '未返回文本')}
                        </pre>
                      </div>
                    </details>
                  ))}
              </details>
            ))}
          </div>
        </>
      ) : (
        <p className="p-6 text-ui-caption text-foreground-subtle">
          发送问题后，这里会显示真实执行轨迹。
        </p>
      )}
    </div>
  )
}
