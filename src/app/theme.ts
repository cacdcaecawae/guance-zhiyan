import { useEffect, useState } from 'react'
import { readPref, writePref } from '@/lib/storage'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'gczy.theme'
const systemDark = matchMedia('(prefers-color-scheme: dark)')

function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && systemDark.matches)
  document.documentElement.classList.toggle('dark', dark)
}

// 当前选择放在模块级：ThemeToggle 随侧栏收起或窄屏抽屉关闭而卸载后仍要跟随系统变化，重新挂载时沿用本次选择。
const stored = readPref(STORAGE_KEY)
let current: Theme = stored === 'light' || stored === 'dark' ? stored : 'system'
const onSystemChange = () => {
  if (current === 'system') applyTheme('system')
}
systemDark.addEventListener('change', onSystemChange)
import.meta.hot?.dispose(() => systemDark.removeEventListener('change', onSystemChange))

/** 主题偏好保存在 localStorage；index.html 中的内联脚本负责首屏无闪烁 */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => current)

  useEffect(() => {
    current = theme
    applyTheme(theme)
  }, [theme])

  const setTheme = (next: Theme) => {
    setThemeState(next)
    writePref(STORAGE_KEY, next)
  }
  return [theme, setTheme]
}
