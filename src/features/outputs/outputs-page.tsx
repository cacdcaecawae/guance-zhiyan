import { TopBar } from '@/app/shell'
import { Placeholder } from '@/features/placeholder'

export function OutputsPage() {
  return (
    <>
      <TopBar title="研究成果" />
      <Placeholder
        title="跨会话成果管理尚未实现"
        description="已生成的报告和表格可在对应会话的文件卡片中下载。"
      />
    </>
  )
}
