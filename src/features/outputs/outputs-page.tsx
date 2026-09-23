import { TopBar } from '@/app/shell'
import { Placeholder } from '@/features/placeholder'

export function OutputsPage() {
  return (
    <>
      <TopBar title="研究成果" />
      <Placeholder
        title="研究成果尚未实现"
        description="这里将用于沉淀研究过程中形成的笔记与报告。当前版本不提供导出或保存功能。"
      />
    </>
  )
}
