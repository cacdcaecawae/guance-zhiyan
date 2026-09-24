# Third-party notices

## DeepSeek Harness

The backend uses the `@deepseek-ai/dsh-*` packages at `0.1.7-rc.1` and
`@deepseek-ai/cordis` at `4.0.4`.

`patches/@deepseek-ai__dsh-llm-deepseek@0.1.7-rc.1.patch` forwards the request's
AbortSignal into both SSE parsing stream pipes. This fixes a reproducible
post-GC cancellation stall with Node 24; it preserves the native adapter and
Agent Loop. `pnpm-workspace.yaml` applies the patch on installation. Remove it
only after an upstream update passes the forced-GC cancellation regression.

`src/features/workspace/reasoning.tsx` adapts the completed-paragraph summary
algorithm from [ReasoningRow.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/client/ui-chat/src/client/chat/ReasoningRow.tsx).
The disclosure markup and styling use this project's components and tokens.
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
