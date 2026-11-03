# 验证集测试

按大赛《验证集评分标准》提供的上传验证集、逐题作答与结果导出。网页入口为侧栏“验证集测试”（`/valset`），同一功能也以 HTTP 接口提供给组委会复核。

## 文件格式

- 上传：`.xlsx`（`.xls` 请先另存为 `.xlsx`），不超过 10 MB；读取第一个工作表，第一行为表头，第一列“问题”、第二列“预期答案”（也接受“预期答案（参考答案）”“参考答案”），其余列忽略。问题为空的行跳过，最多 1000 条，单题不超过 8000 字。表头不符、文件无法读取或超过上限时整份拒绝并说明原因。直接读取 OOXML（组委会模板由 openpyxl 生成、带批注，ExcelJS 无法打开），边解压边解析，问题数超过上限即停，单个部件解压超过 64 MB 时拒绝。
- 模板：页面“下载模板”或 `GET /api/valset/template`，只有两列表头。
- 导出：列同组委会模板 5——`问题 | 预期答案 | 智能体实际回复 | 耗时(秒) | 状态`。回复为纯文本：去掉 Markdown 标记、链接地址与原文引用编号，保留链接文字；有序列表保留序号，表格每行一行、单元格以制表符分隔。没有回复时写“（空）”。耗时保留一位小数。

## 执行方式

- 每题新开一个会话，经与网页提问相同的 Agent 运行时作答（含文献库检索与工具），取最终回答（界面复制的同一段）转成纯文本。会话不列入侧栏研究记录，可从验证集页面每行的“查看”打开，核对带引用的完整回答。
- 模型：第一个已配置密钥的供应商的第一个模型（默认部署为校内 `campus/qwen3.8-27b`），任务记录所用模型。
- 全部任务与单题接口合计同时作答 `VALSET_CONCURRENCY` 题（默认 2）：任务的题按上传顺序排队，单题接口调用在名额满时等候，并优先于任务中尚未开始的题。
- 单题时限 `VALSET_TIMEOUT_SECONDS` 秒（默认 180，即大赛上限），超时停止该题会话。
- 状态：`正常`（有回复）、`超时`、`失败`（模型或服务出错、没有返回正文，原因写入任务日志并显示在页面）、`已取消`。按评分标准，后三种的回复为空、记 0 分。
- 任务与结果保存在 `DATA_DIR/valset/<任务 id>.json`，即每题的输入、预期答案、纯文本回复、耗时、状态、失败原因与会话 id；单题接口的调用另追加到 `DATA_DIR/valset/ask.jsonl`。刷新页面不影响执行；服务重启后已完成的结果保留，未完成的题重新执行。执行中的任务可取消：进行中的题停止，未开始的题记为已取消。每题会话会一直保留，结果导出后可在页面“删除任务”（或调用删除接口），连同各题会话、会话文件与任务记录一并删除，无法恢复。

## 接口

与网站其他接口使用同一登录态。另可在 `server/.env` 设置 `VALSET_API_TOKEN`（足够长的随机串），请求头带 `Authorization: Bearer <令牌>` 即可免登录调用 `/api/valset/*`，令牌对其他接口无效；不设置时只认登录。令牌调用以固定身份“验证集接口”执行，看不到网页用户的任务。

| 方法与路径                          | 说明                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/valset/jobs`             | `multipart/form-data`，文件字段名 `file`；创建并开始任务，返回 201 与任务（含 `id`）                                                      |
| `GET /api/valset/jobs`              | 当前身份最近 50 个任务的摘要：`id`、`name`、`createdAt`、`state`、`total`、`finished`                                                     |
| `GET /api/valset/jobs/{id}`         | 任务进度：`state`（`running` / `done` / `cancelled`）、`model`，以及每题 `question`、`status`、`running`、`seconds`、`sessionId`、`error` |
| `GET /api/valset/jobs/{id}/export`  | 下载结果 `.xlsx`；任务仍在执行时返回 409                                                                                                  |
| `POST /api/valset/jobs/{id}/cancel` | 取消任务，返回任务                                                                                                                        |
| `DELETE /api/valset/jobs/{id}`      | 删除任务及其各题会话；任务仍在执行时返回 409。校园网会断开 DELETE 请求，可改用 `POST` 并加请求头 `X-HTTP-Method-Override: DELETE`         |
| `POST /api/valset/ask`              | JSON `{"question": "…"}`；同步作答一题，返回 `{"answer", "seconds", "status", "error", "sessionId"}`，`answer` 为纯文本，失败时为空       |
| `GET /api/valset/template`          | 下载上传模板                                                                                                                              |

错误返回 `{"error": "原因"}` 与相应状态码（400 文件或参数无效、401 未登录或令牌不符、404 任务不存在、409 尚未结束、413 文件过大）。

```bash
BASE=https://<部署地址>; AUTH="Authorization: Bearer $VALSET_API_TOKEN"
curl -H "$AUTH" -F file=@验证集.xlsx $BASE/api/valset/jobs           # 返回任务 id
curl -H "$AUTH" $BASE/api/valset/jobs/<id>                            # 查看进度
curl -H "$AUTH" -o 结果.xlsx $BASE/api/valset/jobs/<id>/export        # 结束后下载
curl -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"question":"……"}' $BASE/api/valset/ask                         # 单题
```

单题接口与任务共用并发名额，名额满时先排队，`seconds` 从开始作答算起、不含排队时间；作答结束前不返回，调用方与反向代理的读取超时需大于排队时间加 `VALSET_TIMEOUT_SECONDS`。

## 限制

- 单进程内存排队，每题完成即重写整份任务文件；多进程部署或任务远大于 1000 题时改为数据库记录。
- 配置沙箱时，模型在某题中调用命令工具会为该题会话创建沙箱，受沙箱容量限制。
- 不按任务选择模型，也不自动清理旧任务的会话；需要时再加。
