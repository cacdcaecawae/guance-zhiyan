# ADR 0002：数据访问入口与演示模式

日期：2026-09-22 · 状态：已采纳

## 背景

首期没有真实后端，但界面需要会话、回答、引用与片段数据，并且要为将来替换真实实现留好位置，同时不引入重复状态源。

## 决定

- `src/services/` 是 UI 唯一的数据访问入口，可按领域分文件；当前的 `research.ts` 以模块级内存状态 + `useSyncExternalStore` 暴露会话，提供 `createSession` / `askQuestion` / `retryAnswer` / `getPassage` / `getDocument`
- 演示数据与模拟请求集中在 `src/mocks/`；页面不得直接导入
- 类型只覆盖当前界面实际使用的形状（`Session`、`Message`、`Citation`、`Document`、`Passage`），见 `src/types/index.ts`
- 模拟请求只模拟“一次数据请求”的延迟与失败，不模拟 Agent 执行；可复现触发词：`演示空结果`、`演示失败`
- 所有演示内容为明确虚构的中性占位文本，界面统一标注“演示模式 / 非真实检索结果”
- 当前阶段会话不持久化（接入后端时另议）；本地存储只用于主题、侧栏等非敏感界面偏好

## 后果

- 导入边界由 `.oxlintrc.json` 的 `no-restricted-imports` 强制，只有 `src/services/` 与 `src/mocks/` 自身可以导入 mocks
- 数据访问保持集中在 `src/services/`：接入真实后端时以替换 `fetchDemoAnswer` 与片段 / 文献查询为主；`getPassage` / `getDocument` 目前为同步读取，改为网络请求后允许补充必要的类型与界面状态（加载、失败、重试），组件不得绕过 services 直接请求
- 不引入 Redux / Zustand 等状态库；若状态复杂度显著上升，需另立 ADR
