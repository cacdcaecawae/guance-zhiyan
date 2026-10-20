# Third-party notices

## DeepSeek Harness

The backend uses the `@deepseek-ai/dsh-*` packages at `0.1.7-rc.1` and
`@deepseek-ai/cordis` at `4.0.4`.

`patches/@deepseek-ai__dsh-llm-deepseek@0.1.7-rc.1.patch` forwards the request's
AbortSignal into both SSE parsing stream pipes. This fixes a reproducible
post-GC cancellation stall with Node 24; it preserves the native adapter and
Agent Loop. `pnpm-workspace.yaml` applies the patch on installation. Remove it
only after an upstream update passes the forced-GC cancellation regression.

`patches/@deepseek-ai__dsh-http-proxy@0.1.7-rc.1.patch` makes the proxy
package's global dispatchers use HTTP/1.1 (`allowH2: false`). The package builds
them with undici 8, which negotiates HTTP/2, while Node 24's built-in `fetch`
(undici 7) receives no response headers from them over HTTP/2, so compressed
model streams arrive undecoded whenever `HTTPS_PROXY` is set. HTTP/1.1 is what
the built-in `fetch` uses on its own. Remove the patch only after an upgrade of
the package or of Node passes `server/network.test.ts` (HTTPS proxy, bypassed
proxy and compressed responses) without it.

`src/features/workspace/reasoning.tsx` adapts the completed-paragraph summary
algorithm from [ReasoningRow.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/client/ui-chat/src/client/chat/ReasoningRow.tsx).
The disclosure markup and styling use this project's components and tokens.
`execution-process.tsx` adapts the process/final-answer boundary and disclosure
layout from `packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts`
and `chat/TurnProcessNodeView.tsx`; it and `tool-display.ts` adapt the process
grouping, activity titles, tool-name categories and group disclosure from
`conversation-nodes/process-groups.ts`, `conversation-nodes/process-activity.ts`,
`chat/step-process.ts` and `chat/ChatGroupSeat.tsx`, following the rules in
`conversation-nodes/README.zh.md`. `trajectory.tsx` adapts the timeline lanes,
turn grouping and event disclosure layout from `packages/client/ui-trajectory`.
These views use this project's React data service and semantic tokens instead
of the upstream client plugin runtime. `server/network.ts` reuses
`@deepseek-ai/dsh-http-proxy` at the same pinned version, with the patch above.
Upstream commit: `46a7f68b0922371ce7144b668b90e377d8e799f4`.

Upstream [license](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/LICENSE):

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

# 沙箱依赖

OpenSandbox SDK 使用 `@alibaba-group/opensandbox` 1.1.0（Apache-2.0）；管理服务固定上游提交 `2f5e56ab15846e661da53fb24a4caa4ec3f2008d`，复用绑定地址修复。egress 基于官方 `v1.1.7` 镜像，只增加工作负载 uid 的控制端口阻断规则。来源：https://github.com/opensandbox-group/OpenSandbox 。

DSH `tool-bash`、`tool-fs`、`shell`、`shell-env`、`fs`、`fs-local` 均固定 `0.1.7-rc.1`（MIT）；文件 worker 调用原包，不复制其原子编辑实现。

## Noto Serif SC

The wordmark outlines in `src/app/logo-glyphs.ts` and `docs/brand/*.svg` are “管策智研”
(weight 600) and “LENS” (weight 700) converted from Noto Serif SC (the Noto build of Source Han Serif;
the variable font from `@fontsource-variable/noto-serif-sc` instantiated at those weights), © Adobe,
licensed under the [SIL Open Font License 1.1](https://openfontlicense.org/).
The web app also self-hosts the Noto Serif SC variable font through
[`@fontsource-variable/noto-serif-sc`](https://fontsource.org/fonts/noto-serif-sc)
(© Adobe, SIL Open Font License 1.1); its WOFF2 files are served unmodified from
the build output.
