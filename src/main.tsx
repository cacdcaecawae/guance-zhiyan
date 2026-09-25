import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 自托管思源宋体（Noto Serif SC，可变字重，按字符范围分块按需加载），保证各电脑上的衬线效果一致
import '@fontsource-variable/noto-serif-sc'
import '@/styles/globals.css'
import { AppRouter } from '@/app/router'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
)
