import { TopBar } from '@/app/shell'
import { Placeholder } from '@/features/placeholder'

export function OutputsPage() {
  return (
    <>
      <TopBar title="研究成果" />
      <Placeholder
        title="敬请期待"
        description="研究成果将汇总各会话生成的报告与表格；目前可在会话文件中下载。"
      />
    </>
  )
}
