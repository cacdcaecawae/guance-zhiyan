import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ModelCatalog, ModelSelection } from '@/types'

// 输入框右下方的模型下拉：触发器只写模型名，平台名放在分组标题和读屏名称里（两个平台有同名模型）；
// 只有一个平台时不显示分组标题。
export function ModelPicker({
  catalog,
  selection,
  disabled,
  onChange,
}: {
  catalog: ModelCatalog
  selection: ModelSelection
  disabled?: boolean
  onChange: (next: ModelSelection) => void
}) {
  const provider = catalog.providers.find((item) => item.id === selection.provider)
  const model = provider?.models.find((item) => item.id === selection.model)
  const missingKey = provider && !provider.configured ? '（未配置密钥）' : ''
  const name = model?.name ?? selection.model
  const grouped = catalog.providers.length > 1
  return (
    <Select
      disabled={disabled}
      value={`${selection.provider}/${selection.model}`}
      onValueChange={(value) => {
        const split = value.indexOf('/')
        onChange({ provider: value.slice(0, split), model: value.slice(split + 1) })
      }}
    >
      {/* 可访问名称以屏幕上显示的模型名开头，语音控制可按所见名称点中 */}
      <SelectTrigger
        aria-label={`模型：${name} · ${provider?.name ?? selection.provider}${missingKey}`}
        className="rounded-full px-2.5 text-foreground-subtlest"
      >
        <SelectValue>
          <span className="truncate">
            {name}
            {missingKey}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent side="bottom" align="end" className="min-w-60">
        {catalog.providers.map((item) => (
          // 分组之间一道细线，扫读时分得清平台
          <SelectGroup
            key={item.id}
            className="not-first:mt-1 not-first:border-t not-first:border-border not-first:pt-1"
          >
            {grouped && (
              <SelectLabel>
                {item.name}
                {!item.configured && <span className="font-normal"> · 未配置密钥</span>}
              </SelectLabel>
            )}
            {item.models.map((option) => (
              <SelectItem
                key={option.id}
                value={`${item.id}/${option.id}`}
                className={item.configured ? undefined : 'text-foreground-subtle'}
              >
                {option.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
