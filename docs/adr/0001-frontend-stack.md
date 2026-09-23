# ADR 0001：前端技术栈与工程基线

日期：2026-09-22 · 状态：已采纳

## 背景

仓库原本为空。需要一个可持续开发的单页 Web 应用基座，用于后续接入 RAG、研究 Agent 与原文溯源。

## 决定

- 单个 Web 应用，不做 monorepo，不建空后端
- React 19 + TypeScript 6 + Vite 8，由官方 `create-vite` 模板生成；沿用模板的 **oxlint** 作为 Lint 工具，不额外引入 ESLint
- Tailwind CSS v4（`@tailwindcss/vite`），tokens 通过 `@theme inline` 映射 CSS 变量
- shadcn/ui 作为唯一基础组件体系，按其“复制即拥有”的方式手写进 `src/components/ui/` 并绑定本项目 tokens，不用 CLI 生成一套无关 token；底层用 Radix 基元
- 路由 `react-router` v8，图标 `lucide-react`
- 测试：Vitest + Testing Library（jsdom）做单元 / 组件测试；Playwright（仅 Chromium）做浏览器测试
- pnpm 10，`packageManager` 固定版本；Node 24 记录于 `.node-version`；锁文件提交

## 后果

- 所有检查通过根目录 `pnpm check` 串联，CI 执行同一命令
- 后续增加影响全局的依赖（状态库、Radix 以外的整套 UI 库、依赖注入等）需要新的 ADR；局部小库与补充基础组件所需的 `@radix-ui/react-*` 基元不在此列
