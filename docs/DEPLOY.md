# 部署与一键启动

完整服务由三部分组成，`deploy/guance.sh` 一条命令启动、守护和停止：

| 组成     | 默认地址                 | 说明                                                                                       |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| 网站     | `127.0.0.1:3001`         | `server/index.ts`，同时提供页面与 `/api`                                                   |
| Qdrant   | `127.0.0.1:6333`（6334） | 向量库；由本脚本运行可执行文件，或用 `server/rag/compose.yaml` 的容器                      |
| 向量服务 | `127.0.0.1:8081`         | `server/rag/embed-server.py`（BGE-M3），或任一兼容 OpenAI `/embeddings` 协议的服务         |
| 回答模型 | 校内 `10.27.66.12`       | 学校 GPUStack，只在校园网可达，不由本项目运行                                              |
| 沙箱     | 可选                     | Bash 与文件执行环境，单独部署，见 [沙箱部署](SANDBOX.md)；未配置时聊天照常，不装载命令工具 |

所有组成都只监听本机地址。Qdrant 和向量服务没有密码，不要改成监听公网或局域网地址。

## 访问方式与登录

目前只有**本机模式**（`APP_MODE=local`，即 `pnpm chat` 用的入口）可用：免登录，所有会话属于同一个“本机研究者”，只接受来自 `127.0.0.1:端口` 的请求。从其他电脑访问时经 SSH 隧道转发，**本机端口必须与服务端口一致**（页面会核对地址）：

```bash
ssh -N -L 3001:127.0.0.1:3001 用户名@服务器    # 保持窗口打开，再访问 http://127.0.0.1:3001
```

多人共用、通过网址直接访问需要先接入学校身份认证（`server/auth.ts`），之后改用 `APP_MODE=server` 并按 README 配置 `APP_ORIGIN`、反向代理与 HTTPS。认证接入前普通服务器模式的业务接口一律返回 401。不要把本机模式通过反向代理或公网端口开放给别人：任何能访问它的人都能看到全部会话。

## 首次准备（Linux 或 WSL Ubuntu）

1. **运行环境**：Node 24 与 pnpm 10.34.5（`corepack enable`）。只用 Git 克隆仓库，不要在 Windows 侧克隆后从 WSL 使用。
2. **代码**：`pnpm install --frozen-lockfile && pnpm build`。
3. **应用配置**：复制 `server/.env.example` 为 `server/.env`，至少填写 `CAMPUS_API_KEY`；文献库填写 `EMBEDDING_URL`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`、`QDRANT_URL`（见 [RAG 开发说明](RAG.md)）。`chmod 600 server/.env`。
4. **进程配置**：复制 `deploy/.env.example` 为 `deploy/.env`，按需填写：
   - `QDRANT_BIN`、`QDRANT_STORAGE`：由本脚本运行 Qdrant 可执行文件（[官方发布页](https://github.com/qdrant/qdrant/releases) 下载，版本与 `server/rag/compose.yaml` 一致）；用 Docker 时留空，改为执行一次 `docker compose -p guance-rag-backend -f server/rag/compose.yaml up -d`，容器随 Docker 自启。
   - `EMBED_CMD`：由本脚本运行向量服务。BGE-M3 需要 Python 3、`torch`（有 NVIDIA 显卡时装对应 CUDA 版，CPU 也能运行但导入慢）与 `transformers`，模型 `BAAI/bge-m3` 需事先下载到本机目录，本项目不自动下载：
     ```bash
     python3 -m venv ~/embed-venv && ~/embed-venv/bin/pip install torch transformers
     # EMBED_CMD="BGE_M3_DIR=$HOME/models/bge-m3 $HOME/embed-venv/bin/python server/rag/embed-server.py 8081"
     ```
   - `PATH`：node、pnpm 不在默认 PATH（如装在用户目录、由 systemd 启动）时补上。
   - 需要覆盖 `server/.env` 的同名项（如 `PORT`、`DATA_DIR`）时也写在这里。
5. **数据**：二选一。
   - 新导入：`pnpm rag import <文献.jsonl>`、`pnpm rag metadata <元数据.jsonl>`，见 RAG 说明。全库导入耗时很长，宜在有显卡的机器上完成。
   - 从已有部署迁移：停止两边服务后，**一起**复制 `DATA_DIR`（含 `app.sqlite`，全库约 15 GB）与 Qdrant 数据目录（或 Docker 卷），并保持 `EMBEDDING_URL`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`、`QDRANT_URL` 四项原样。向量集合名和索引完成标记由文献库编号（在 `DATA_DIR` 里）和这几项共同决定，任何一项变化都会被视为新索引，需要 `pnpm rag reindex` 全量重算。

## 日常命令

```bash
deploy/guance.sh run              # 前台启动全部服务；Ctrl+C 停止。同一仓库只会运行一份
deploy/guance.sh status           # 守护进程、网站、Qdrant、向量服务、校内模型是否正常，及代码版本
deploy/guance.sh update           # 拉取 origin/main、安装依赖并构建，成功后只重启网站；可指定版本
deploy/guance.sh stop             # 停止 run 启动的全部服务
```

任一进程退出后 5 秒自动重启；停止时整组结束（向量服务由 shell 拉起的子进程也一并结束），20 秒内未退出的强制结束。日志在 `deploy/logs`（`run.log` 记录启停，另有每个服务一份），不自动轮转，长期运行时定期清理或交给 logrotate（`copytruncate`）。`update` 在工作区有未提交改动或任一步失败时不重启网站；构建直接覆盖 `dist/`，失败时先修复再重新 `update`。

## 开机自启

**Linux 服务器（systemd）**：按 `deploy/guance.service` 开头的注释修改仓库目录与运行账号后安装，之后用 `systemctl status|restart|stop guance` 管理，不再手动执行 `run`。用 Docker 运行 Qdrant 时，单元已排在 `docker.service` 之后。

**Windows + WSL**：WSL 在没有 `wsl.exe` 进程时会空闲关机，从 SSH 或关掉的终端里启动的服务会随之结束。把 `deploy/start-wsl.cmd` 复制到桌面双击：它在隐藏窗口里常驻运行 `deploy/guance.sh run`，30 秒后显示状态，关闭提示窗口不影响服务。仓库不在 `~/guance-app` 或发行版不叫 Ubuntu 时，改文件里的 `REPO`、`DISTRO` 两行（该文件只能含英文字符：中文 Windows 的 `cmd` 在 UTF-8 代码页下会把含中文的行解析错）。开机自启：任务计划程序新建“用户登录时”触发、操作为运行该文件的任务。停止：`wsl -d Ubuntu -- bash -lc "~/guance-app/deploy/guance.sh stop"`。

## 备份

停止服务后一起备份 `DATA_DIR`、Qdrant 数据目录（或 Docker 卷 `guance-rag-backend_qdrant-data`）和 `server/.env`；只恢复其中一部分会出现文献与向量不一致，需要 `pnpm rag reindex`。启用沙箱时另按沙箱文档备份。

## 排查

| `status` 显示    | 先看                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| 守护进程：未运行 | 没有启动，或已被关闭（WSL 是否空闲关机、终端是否被关掉）                            |
| 网站：无响应     | `deploy/logs/app.log`；刚启动或刚更新时等十几秒                                     |
| Qdrant：无响应   | `deploy/logs/qdrant.log`，或 `docker compose ... ps`；端口是否与 `QDRANT_URL` 一致  |
| 向量服务：无响应 | `deploy/logs/embedding.log`；刚启动时要等模型加载完；显存不足时日志里有 OutOfMemory |
| 校内模型：无响应 | 服务器是否在校园网内、能否访问 `CAMPUS_BASE_URL`；密钥是否有效                      |

网站在 Qdrant 或向量服务不可用时照常启动，只是文献库检索会报错，恢复后无需重启网站。

## 迁移到学校服务器前需要确认

- 操作系统与权限：能否长期运行进程、能否用 systemd（或 Docker）开机自启。
- 网络：服务器能否访问校内模型 `10.27.66.12`、能否访问 GitHub 与 npm（拉代码、装依赖）；访问者如何连到服务器（SSH 隧道，或待认证接入后的网址）。
- 算力：有无 NVIDIA 显卡跑 BGE-M3；没有时检索查询仍可用但更慢（未实测具体耗时），全量导入不宜在这样的服务器上做，改为从已有部署迁移数据。
- 磁盘：`DATA_DIR` 约 15 GB，另加 Qdrant 数据与备份空间。
- 多人使用：需要学校身份认证方式，确定后再接入 `server/auth.ts`。
