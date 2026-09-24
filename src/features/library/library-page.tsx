import { TopBar } from '@/app/shell'
import { Placeholder } from '@/features/placeholder'

export function LibraryPage() {
  return (
    <>
      <TopBar title="文献库" />
      <Placeholder
        title="文献库尚未实现"
        description="这里将用于管理研究所依据的政策文本与文献。上传、解析与文献库检索尚未实现；联网搜索目前在会话中使用。"
      />
    </>
  )
}
