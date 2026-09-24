# 管策智研

面向人文社科研究者的政策文本研究工作台。

## 当前进度

已接入 Node.js / TypeScript 后端，直接复用 DeepSeek Harness 的 Agent Loop、模型适配器、会话持久化和联网工具。只有一个综合助手，支持多轮会话、Markdown 流式回答、停止生成、思考折叠、工具追踪，以及 Markdown / Word / Excel / CSV 文件生成与下载。原演示模式和虚构引用已移除。

配置 OpenSandbox 后支持独立会话沙箱中的 Bash、原生文件读写和任意格式产物导出；普通聊天按需启动执行环境。Linux Docker 部署、权限边界与真实容器验收见 [沙箱部署](docs/SANDBOX.md)。未配置时不装载命令工具，不在宿主机执行模型命令。

**首版可以在本机免登录使用。** 配置后端模型密钥后运行 `pnpm chat`，打开 `http://127.0.0.1:3001` 直接进入聊天。会话归属于固定的本机研究者，刷新和重启后保留。

学校登录与账号开通方式仍待定，`server/auth.ts` 保留身份接入边界。普通服务器启动默认返回 401；本机入口不作为公网或多人共享登录方案。内部用户、会话与文件隔离已通过测试身份验证。

文献上传、RAG、原文片段引用与跨会话成果归档尚未实现。联网来源链接不等同于文献库引用。模型和网页都需核对；没有真实 DeepSeek 密钥时，自动化测试只验证受控模型与协议响应，不能代替真实服务验收。

## 本地开发

要求 Node 24 与 pnpm 10.34.5。Node 原生 SQLite 当前会输出实验性功能提示。

```bash
pnpm install
pnpm exec playwright install chromium   # Linux 首次加 --with-deps
# 复制 server/.env.example 为 server/.env，填写 DEEPSEEK_API_KEY 和/或 QIANWEN_API_KEY
pnpm chat                              # 构建并启动本机聊天 http://127.0.0.1:3001
```

`pnpm chat` 显式传入 `--local`，强制监听 `127.0.0.1`，同源提供构建后的网页和 API；本机模式忽略 `HOST` 与 `APP_ORIGIN`，端口可通过 `PORT` 调整。校验回环请求地址、准确 Host/端口、Origin 与浏览器来源，并拒绝转发头。无需填写账号或密码，也没有演示回答回退。该入口不应通过反向代理、隧道或共享电脑开放给其他人。

开发页面可用 `pnpm dev`，Vite 将 `/api` 代理到 `pnpm dev:server`；这条普通服务器路径仍需接入可信认证才能访问业务接口。本机聊天入口使用构建产物，改代码后重新运行 `pnpm chat`。学校认证未来在 `server/auth.ts` 验证身份并返回稳定的 `subject` 与显示名；不得直接信任浏览器提交的用户 ID、测试 Cookie 或未经验证的身份头。账号开通、登录页和退出流程待认证方式确定后实现。

后端配置见 [server/.env.example](server/.env.example)：

| 配置                       | 用途                                                       |
| -------------------------- | ---------------------------------------------------------- |
| `DEEPSEEK_API_KEY`         | 仅后端使用的模型与搜索密钥                                 |
| `QIANWEN_API_KEY`          | 千问 AI 平台按量付费密钥，用于该平台的 DeepSeek 对话与搜索 |
| `QIANWEN_BASE_URL`         | 默认 `https://maas.qianwenaiapi.com/apps/anthropic`        |
| `DEEPSEEK_BASE_URL`        | 对话端点，默认 `https://api.deepseek.com/anthropic`        |
| `DEEPSEEK_SEARCH_BASE_URL` | 独立搜索端点，默认 `https://api.deepseek.com/anthropic/v1` |
| `APP_ORIGIN`               | 浏览器访问的准确来源，开发默认 `http://localhost:5173`     |
| `HOST` / `PORT`            | 后端绑定地址与端口，默认 `127.0.0.1:3001`                  |
| `DATA_DIR`                 | 私有数据目录，默认 `server/data`                           |

网页可分别选择供应商和模型，两家均运行 DeepSeek，不包含 Qwen 模型。发送成功后按会话保存选择，刷新和服务重启后恢复；生成期间禁止切换。切换供应商会将会话历史发送至所选平台，联网搜索也使用该平台与所选模型。密钥未配置时明确提示，不自动换供应商。模型由后端允许列表提供，不接受浏览器传入端点或密钥；原 `DEEPSEEK_MODEL` 配置已由网页选择替代。

| 供应商        | Flash                    | Pro                    |
| ------------- | ------------------------ | ---------------------- |
| DeepSeek 官方 | `deepseek-flash`（V4.1） | `deepseek-v4-pro`      |
| 千问 AI 平台  | `deepseek-v4.1-flash`    | `deepseek-v4-pro-0813` |

模型名称和参数核对于 2026-09-24：[DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models/)、[官方 Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api/)、[千问 Anthropic 接口](https://platform.qianwenai.com/docs/api-reference/chat/anthropic)。两家对话均复用 DSH `0.1.7-rc.1` 的 Anthropic Messages 适配器与流式协议，开启思考，`output_config.effort=high`，输出长度沿用 DSH 默认 `max_tokens=256000`（包含思考与正文），不发送 `budget_tokens` 或采样参数。模型列表按已核对文档维护，不能保证自动跟随将来的命名变化。

官方联网搜索复用 DSH 工具，显式使用当前模型，保留独立 `DEEPSEEK_SEARCH_BASE_URL`；更改官方对话端点不会自动更改其搜索端点。千问搜索使用同一 `QIANWEN_BASE_URL` 下的 Messages 接口，按[平台联网搜索文档](https://platform.qianwenai.com/docs/developer-guides/tool-calling/web-search)附加所需 system 标识，关闭辅助搜索的思考；两家搜索均沿用 DSH 搜索默认值：最多 5 次原生搜索、4096 输出 tokens。没有实际搜索结果块或请求失败时显示工具失败。两家密钥独立，只放后端，不得写入 `VITE_` 环境变量。

| 命令                              | 说明                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| `pnpm chat`                       | 构建并启动本机免登录聊天，仅监听回环地址                          |
| `pnpm dev` / `pnpm dev:server`    | 前端 / 后端开发服务器                                             |
| `pnpm build`                      | 前端类型检查与构建                                                |
| `pnpm start`                      | 后端同时提供 `dist/` 与 `/api`；先完成认证接入并配置 `APP_ORIGIN` |
| `pnpm preview`                    | 仅预览前端产物，不提供后端 API                                    |
| `pnpm typecheck`                  | 前后端与测试的 TypeScript 检查                                    |
| `pnpm test`                       | Vitest 与 Node 后端集成测试                                       |
| `pnpm test:server`                | 单独运行后端集成测试                                              |
| `pnpm test:sandbox`               | 对真实 OpenSandbox / Docker 验证执行隔离、持久化与停止            |
| `pnpm test:e2e`                   | Playwright 自动启动测试后端与前端，无需模型密钥                   |
| `pnpm lint` / `pnpm format:check` | Lint / 格式检查；`pnpm format` 自动格式化                         |
| `pnpm check`                      | 格式、Lint、类型、单元及集成测试、构建、浏览器测试                |

浏览器测试先构建前端，独占 3001、3002 与 4173 端口，运行前停止这些端口上的服务。`tests/support/` 中的身份与模型替身只由测试入口加载，应用没有演示模式或测试身份配置开关。本机入口测试另起正式服务进程，将真实 DSH 适配器指向受控协议服务，验证免登录、多轮、刷新恢复、流式与停止；这不代表真实 DeepSeek 联调已完成。CI 在 PR 与主分支 push 时运行同样的 `pnpm check`。

## 存储与运行边界

工作区提供“对话 / 轨迹”：对话按 DSH 的紧凑执行过程展示多次思考、工具和最终回答；轨迹按轮次展开真实系统输入、用户、上下文、模型和工具事件，顶部可切换记录耗时与事件顺序，并控制轮次展开和工具行显示。刷新后由同一份 JSONL 历史恢复，停止保留已返回的文本；不展示凭据、协议签名或内部请求头。

出站网络复用 DSH 原生代理策略，支持可选的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`。本机代理使用 fake-IP DNS 时，在后端 `server/.env` 设置已有代理地址（例如 `HTTPS_PROXY=http://127.0.0.1:7890`，HTTP 同理），使代理解析公网域名；部署时使用服务器自己的代理或留空。应用不修改操作系统网络设置，仍拒绝私网 IP 字面量；代理模式下域名解析交由所配置的代理。千问原生搜索的 system 标识必须以文本块数组传入，字符串形式无法触发实际搜索。

SQLite 保存内部用户、会话归属、沙箱实例及文件索引；DSH JSONL 保存唯一的消息与执行历史；产物文件单独保存。停止服务后备份整个 `DATA_DIR`，数据库、日志与产物必须一起恢复。启用沙箱后另备份管理服务状态与会话工作区卷，卷不在 `DATA_DIR` 内。该目录包含私有研究数据，应由服务账号独占访问，不能作为静态目录公开。

首版使用单进程，每会话同时只执行一个任务。Agent 执行与联网工具沿用 DSH 默认参数：工具并行数 10，模型流连续无数据超时 300 秒；网页读取最多 5 MB、100000 字符、30 秒。应用不另设总任务数、每人任务数、任务步骤、工具调用总次数、总时长、流式分片数或 JSON 字符上下文上限，也不自动删历史。模型服务本身的输出和上下文上限仍然有效，真实截断会显示未完成；旧会话下次发送也采用新默认值。会话列表展示最新 100 条。文件正文上限 200 KB，表格最多 2000 行、50 列，每人产物总量 50 MiB。尚无文件清理界面。

基础工具为 `web_search`、`web_fetch`、`create_file`、`list_files`、`read_file`。网页抓取复用 DSH 公网地址校验；文件读取仅限当前用户的当前会话产物。Word 生成器支持段落及三级标题，Excel/CSV 支持文本与数字表格；不承诺完整 Markdown 到 Word 的排版还原或 Office 在线预览。配置沙箱后增加 DSH 原生 `bash`、`read`、`write`、`edit` 与项目 `export_file`，可执行 Python/Node 生成其他格式文件；没有子 Agent。沙箱容量与资源配额独立于聊天循环，见部署文档。

服务重启后恢复已保存历史；意外中断标为停止。SSE 断开不自动取消后台任务，重新连接会读取当前状态；停止按钮取消对应会话。身份集成后部署时，反向代理需支持 SSE、关闭该接口缓冲并提供 HTTPS。多进程共享执行状态不在当前实现范围。

## 目录与后续

- `src/services/`：界面唯一数据入口；`src/features/`：业务界面；`src/components/ui/`：基础组件。
- `server/`：身份边界、HTTP、SQLite 索引、DSH 运行与事件投影、文件工具。
- `tests/support/`、`tests/e2e/`：测试专用模型、测试主机与浏览器验收。
- `docs/adr/`：架构决策；复用代码来源与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

下一阶段：确定学校认证接入；使用真实服务验收会话与联网工具；实现文献上传、解析、混合检索与原文引用；之后比较重排模型，再规划跨文献研究流程。

开发前阅读 `AGENTS.md`、`docs/DEVELOPMENT.md`、`DESIGN.md`、`CONTEXT.md` 与 [ADR 0004](docs/adr/0004-server-agent-runtime.md)。
