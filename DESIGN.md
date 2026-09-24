# DESIGN.md

本项目的视觉与交互规范。基调：安静、紧凑、清晰、适合长时间阅读的研究工具；不是营销页，也不是数据驾驶舱。

参考来源：规则裁剪自 [ZCode DESIGN.md](https://github.com/zai-org/ZCode/blob/main/DESIGN.md)（语义 tokens、`text-ui-*` 字号体系、圆角嵌套递减、克制的层次与阴影）。本文件是本地规范，不自动跟随上游变化。

## 颜色

所有颜色只在 `src/styles/tokens.css` 定义，浅色在 `:root`，深色在 `.dark`。组件只用语义类名，不写硬编码颜色（hex、`white` / `black` 等非语义色及其透明度变体，如 `text-white/60`）；语义 token 可加透明度，仅用于弱边框与悬停（如 `border-brand/40`、`hover:bg-primary/90`）；遮罩用 `bg-overlay`。

| 类别     | Token（Tailwind 类前缀 `bg-` / `text-` / `border-`）                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| 结构面   | `background` 页面、`sidebar` 侧栏、`surface` / `surface-hover` 内容面、`card` / `card-border` 卡片            |
| 边框     | `border` 分隔线与控件边框、`border-hover` 悬停边框                                                            |
| 浮层     | `popover` / `popover-border`（抽屉、菜单、对话框）、`overlay` 遮罩                                            |
| 输入     | `input` / `input-focused`、`input-border` / `input-border-hover` / `input-border-focused`                     |
| 文本     | `foreground` 正文、`foreground-subtle` 次要、`foreground-subtlest` 弱提示                                     |
| 状态面   | `hover` 悬停、`selected` 选中、`accent` 弱强调面（用户消息、激活引用）、`tag` 徽标、`find-highlight` 片段高亮 |
| 强调     | `brand` 仅用于引用角标、链接等少量强调；`primary` / `primary-foreground` 主按钮；`ring` 焦点环                |
| 语义状态 | `destructive` 错误，只用于真实状态，不做装饰；需要成功、警告等状态色时再补，并复核对比度                      |

规则：

- 页面根 `bg-background text-foreground`；内容容器 `bg-card` 或 `bg-surface`；浮层 `bg-popover`
- 品牌色不做大面积填充；不使用渐变背景、玻璃效果
- 用文字层级表达信息密度，再考虑加边框或颜色
- 文字颜色对其所在背景的对比度不低于 4.5:1（WCAG AA），`foreground-subtlest` 也不例外；修改 `tokens.css` 或把文字放到新背景上时复核

## 字体与字号

- 系统无衬线栈并兼容中文（`font-sans`，定义于 tokens）；`font-mono` 只用于编号、路径等技术值
- 界面文字只用 `text-ui-*`，不用 Tailwind 内置 `text-sm` / `text-base` 或任意像素值。基准 `--ui-font-size: 14px`

| Token             | 大小 | 用途                               |
| ----------------- | ---- | ---------------------------------- |
| `text-ui-xl`      | 18px | 页面级标题（欢迎标题）             |
| `text-ui-lg`      | 16px | 二级标题、项目名                   |
| `text-ui-base`    | 14px | 正文、按钮、输入、面板标题（默认） |
| `text-ui-caption` | 13px | 需要比正文低一级的紧凑说明         |
| `text-ui-sm`      | 12px | 辅助说明、分组标题、提示           |
| `text-ui-xs`      | 10px | 仅弱徽标与引用角标，不承担正文阅读 |

标题层级优先用字重（`font-medium` / `font-semibold`）区分，不靠放大字号。

## 间距与尺寸

- 基础单位 4px，常用 8 / 12 / 16 / 24px（`gap-2` `p-3` `p-4` `gap-6`）
- 控件高度 `h-7` / `h-8`；图标 `size-4` 为基准；图标按钮 `size-7` / `size-8` 正方形
- 内容区宽度 `w-full max-w-2xl` 居中；侧栏 `w-64`
- 弹性布局中需要截断时加 `min-w-0`，嵌套滚动时加 `min-h-0`
- 长链接、长编号由 `body` 上的 `wrap-break-word` 自动折行，块级文本不必各自处理；flex 行内可能出现长串的项需加 `min-w-0`；需要单行时用 `truncate`

## 圆角

按可见圆角容器的嵌套层级递减，不按重要性：

- 主内容区的第一层圆角容器用 `rounded-xl`（回答卡片、用户消息、输入区外壳、占位卡片）；侧面板（资料面板等）内的内容块用 `rounded-lg`
- 嵌套依次 `rounded-lg` → `rounded-md` → `rounded-sm`
- 基础控件默认 `rounded-lg`；放在圆角容器内时用 `rounded-md`（如主题切换分段、输入区内的发送按钮、回答卡片内的重试按钮）
- 徽标与引用角标 `rounded-sm`
- 不用 `rounded-2xl`、`rounded-full` 或裸 `rounded`；边缘贴合的抽屉不加圆角

## 层次与阴影

- 主要靠背景对比和边框分层；页面与侧栏无阴影
- 浮层（抽屉、对话框、菜单）用 `shadow-md`；不做厚重阴影
- 动效保持短促克制：状态变化用 `transition-colors`，加载指示可用 `animate-spin`；不做装饰性的入场、位移、缩放动效

## 组件

基础组件在 `src/components/ui/`，均为 shadcn/ui 风格、绑定本项目 tokens：

- `Button`：`default` 主按钮（每个面板最多一个）、`outline`、`ghost`；尺寸 `default` / `sm` / `icon` / `icon-sm`
- `Textarea`：`bg-input` + `border-input-border`，悬停与聚焦只改边框色，不发光
- `Sheet`：窄屏抽屉，带 `sr-only` 标题与“关闭”按钮
- `Badge`：通用弱徽标

交互元素必须有悬停与键盘焦点（`focus-visible:ring-2 ring-ring`）状态，可禁用的控件要有禁用样式；切换、当前项、展开分别用 `aria-pressed`、`aria-current`、`aria-expanded` 表达，普通按钮和链接不加；图标按钮必须有 `aria-label`。

## 布局

```
左侧导航与会话列表 | 中央研究工作区（回答、执行过程与会话文件）
```

- ≥768px：侧栏常驻，可通过顶部栏按钮折叠（偏好写 localStorage）；<768px：侧栏为左侧抽屉
- 资料面板随真实文献库引用后续实现，当前不显示虚构片段
- 顶部栏 `h-12`：侧栏开关、会话标题（截断并带 `title`）
- 中央区：消息列表可滚动，输入区固定在底部；空会话显示欢迎状态与示例问题
- 主题：浅色 / 深色 / 跟随系统，`.dark` 类挂在 `html` 上，`index.html` 内联脚本避免首屏闪烁；`color-scheme` 随主题切换，原生滚动条与控件跟随所选主题

## 回答与执行状态

- 空结果、失败与重试有明确文案；未实现功能显示“尚未实现”，不显示假成功
- 应用无演示模式；测试模型只存在于自动化测试中
- 正文用安全 Markdown 渲染，禁止原始 HTML、危险链接及外部图片自动加载；表格和代码块局部滚动
- 思考折叠默认关闭，工具调用用独立折叠项展示参数与结果，均依据后端实际事件
- 生成中提供停止按钮；完成、失败、停止分别展示，不将网络断开误判为生成完成
- 输入区提供供应商与 DeepSeek 模型选择，生成中禁用；明确标出缺少密钥的供应商，提示所选平台会接收会话历史；选择随成功发送保存至会话
- 请求失败保留草稿；失败或停止后“重新提问”追加一次新的提问，保留原始记录
- 文件生成成功后才出现下载卡片，文献库和成果归档未实现时明确说明
