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

// 输入区底行的模型下拉：按平台分组；两个平台有同名模型，所以触发器文字带平台名，选项只写模型名。
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
  return (
    <Select
      disabled={disabled}
      value={`${selection.provider}/${selection.model}`}
      onValueChange={(value) => {
        const split = value.indexOf('/')
        onChange({ provider: value.slice(0, split), model: value.slice(split + 1) })
      }}
    >
      <SelectTrigger aria-label="模型">
        <SelectValue>
          {model?.name ?? selection.model} · {provider?.name ?? selection.provider}
          {provider && !provider.configured && '（未配置密钥）'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-60">
        {catalog.providers.map((item) => (
          <SelectGroup key={item.id}>
            <SelectLabel>
              {item.name}
              {!item.configured && <span className="font-normal"> · 未配置密钥</span>}
            </SelectLabel>
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
