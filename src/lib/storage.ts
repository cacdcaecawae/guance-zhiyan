// 界面偏好的本地存储。沙箱页面（如分享版）或禁用站点数据时 localStorage 会抛错，此时按“没有偏好”处理。

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 同上：存不下就只在本次打开期间生效
  }
}
