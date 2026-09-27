import { TopBar } from '@/app/shell'
import { Placeholder } from '@/features/placeholder'

export function LibraryPage() {
  return (
    <>
      <TopBar title="文献库" />
      <Placeholder
        title="敬请期待"
        description="文献库将用于上传、解析和检索研究所依据的政策文本与文献。"
      />
    </>
  )
}
