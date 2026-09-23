import { TopBar } from '@/app/shell'
import { Placeholder } from '@/features/placeholder'

export function LibraryPage() {
  return (
    <>
      <TopBar title="文献库" />
      <Placeholder
        title="文献库尚未实现"
        description="这里将用于管理研究所依据的政策文本与文献。当前版本只提供演示会话中的虚构示例文件，不支持上传或解析。"
      />
    </>
  )
}
