# 部署与开机自启

完整服务由下面几部分组成。Qdrant、向量服务与网站交给系统自带的 systemd 守护：`deploy/guance.sh install` 生成并安装服务，之后崩溃自动重启、开机自启、停止时连同子进程一起结束都由 systemd 负责。

| 组成     | 默认地址                 | 说明                                                                                        |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| 网站     | `127.0.0.1:3001`         | `server/index.ts`，同时提供页面与 `/api`；服务名 `guance-app`                               |
| Qdrant   | `127.0.0.1:6333`（6334） | 向量库；本机运行可执行文件（服务名 `guance-qdrant`），或用 `server/rag/compose.yaml` 的容器 |
| 向量服务 | `127.0.0.1:8081`         | `server/rag/embed-server.py`（BGE-M3，服务名 `guance-embedding`），或任一兼容的服务         |
| 回答模型 | 校内 `10.27.66.12`       | 学校 GPUStack，只在校园网可达，不由本项目运行                                               |
| 沙箱     | 可选                     | Bash 与文件执行环境，单独部署，见 [沙箱部署](SANDBOX.md)；未配置时聊天照常，不装载命令工具  |

所有组成都只监听本机地址。Qdrant 和向量服务没有密码，不要改成监听公网或局域网地址。

## 访问方式与登录

目前只有**本机模式**（`APP_MODE=local`，即 `pnpm chat` 用的入口）可用：免登录，所有会话属于同一个“本机研究者”，只接受来自 `127.0.0.1:端口` 的请求。从其他电脑访问时经 SSH 隧道转发，**本机端口必须与服务端口一致**（页面会核对地址）：

```bash
ssh -N -L 3001:127.0.0.1:3001 用户名@服务器    # 保持窗口打开，再访问 http://127.0.0.1:3001
```

多人共用、通过网址直接访问需要先接入学校身份认证（`server/auth.ts`），之后改用 `APP_MODE=server` 并按 README 配置 `APP_ORIGIN`、反向代理与 HTTPS。认证接入前普通服务器模式的业务接口一律返回 401。不要把本机模式通过反向代理或公网端口开放给别人：任何能访问它的人都能看到全部会话。

## 首次准备（Linux 或 WSL Ubuntu）

1. **运行环境**：Node 24 与 pnpm 10.34.5（`corepack enable`），以及 systemd（Linux 服务器一般自带；WSL 见下文“WSL”一节打开）。只用 Git 克隆仓库，不要在 Windows 侧克隆后从 WSL 使用。仓库路径不能含空格、引号、`%`、`$` 或反斜杠（systemd 单元里直接写这个路径）。
2. **代码**：`pnpm install --frozen-lockfile && pnpm build`。
3. **应用配置**：复制 `server/.env.example` 为 `server/.env`，至少填写 `CAMPUS_API_KEY`；文献库填写 `EMBEDDING_URL`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`、`QDRANT_URL`（见 [RAG 开发说明](RAG.md)）。`chmod 600 server/.env`。密钥只在这里，由网站用 `node --env-file` 读取，不写进 systemd 单元，也不出现在任何进程的参数里。
4. **进程配置**：复制 `deploy/.env.example` 为 `deploy/.env`，按需填写：
   - `QDRANT_BIN`、`QDRANT_STORAGE`：由本机运行 Qdrant 可执行文件（[官方发布页](https://github.com/qdrant/qdrant/releases) 下载，版本与 `server/rag/compose.yaml` 一致）；用 Docker 时留空，改为执行一次 `docker compose -p guance-rag-backend -f server/rag/compose.yaml up -d`，容器随 Docker 自启。
   - `EMBED_CMD`：由本机运行向量服务。BGE-M3 需要 Python 3、`torch`（有 NVIDIA 显卡时装对应 CUDA 版，CPU 也能运行但导入慢）与 `transformers`，模型 `BAAI/bge-m3` 需事先下载到本机目录，本项目不自动下载：
     ```bash
     python3 -m venv ~/embed-venv && ~/embed-venv/bin/pip install torch transformers
     # EMBED_CMD="BGE_M3_DIR=$HOME/models/bge-m3 $HOME/embed-venv/bin/python server/rag/embed-server.py 8081"
     ```
   - `PATH`：systemd 启动的服务只有系统默认 PATH，node 装在用户目录等处时补上。
   - 只能写 `PATH`、`QDRANT_BIN`、`QDRANT_STORAGE`、`EMBED_CMD`、`APP_MODE`。数据目录、端口等应用配置只写在 `server/.env`：网站与 `pnpm rag` 导入命令都只读那里，分两处写会让导入写进网站看不到的目录，所以 `deploy/.env` 出现应用配置、有语法错误、或 `APP_MODE` 不是 `local` / `server` 时拒绝安装和更新；已装的服务启动时同样检查，出错即停（不反复重启），`status` 显示原因。相对路径按仓库根目录解析。
5. **数据**：二选一。
   - 新导入：`pnpm rag import <文献.jsonl>`、`pnpm rag metadata <元数据.jsonl>`，见 RAG 说明。全库导入耗时很长，宜在有显卡的机器上完成。
   - 从已有部署迁移：停止两边服务后，**一起**复制 `DATA_DIR`（含 `app.sqlite`，全库约 15 GB）与 Qdrant 数据目录（或 Docker 卷），并保持 `EMBEDDING_URL`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`、`QDRANT_URL` 四项原样。向量集合名和索引完成标记由文献库编号（在 `DATA_DIR` 里）和这几项共同决定，任何一项变化都会被视为新索引，需要 `pnpm rag reindex` 全量重算。数据目录不要放在 `/tmp`（服务有自己独立的 `/tmp`），也不要放在 `/usr`、`/etc` 下（服务对它们只读）。
6. **安装服务**：在仓库根目录，以运行服务的账号（不必是 root）执行 `deploy/guance.sh install`。它生成 `guance-app`（以及配置了的 `guance-qdrant`、`guance-embedding`）单元，经 `sudo` 写入 `/etc/systemd/system/`，设为开机自启并启动，等网站健康检查通过才报告成功。仓库里没有单元模板文件，不需要改任何仓库文件。

## 日常命令

```bash
deploy/guance.sh status                      # 各服务运行状态，网站、Qdrant、向量服务、校内模型是否正常，及代码版本
deploy/guance.sh update                      # 停网站 → 拉取 origin/main → 安装依赖 → 构建 → 启动网站；可指定版本
sudo systemctl restart guance-app            # 重启（停止用 stop；Qdrant、向量服务换成 guance-qdrant、guance-embedding）
journalctl -u guance-app -f                  # 查看日志
```

- **守护**：每个服务退出后 5 秒由 systemd 重启；停止时 systemd 结束服务的整个控制组（含向量服务由 shell 拉起的子进程），20 秒内未退出的强制结束。网站排在 Qdrant 与向量服务之后启动；它们不可用时网站照常运行，只是文献库检索报错，恢复后无需重启网站。
- **加固**：各服务以安装账号运行，带 `NoNewPrivileges`（不能再提权）、`PrivateTmp`（独立 `/tmp`）、`ProtectSystem=full`（`/usr`、`/etc` 等只读）和 `UMask=0077`（新建文件只有本账号能读）。
- **更新**：`update` 先停网站，在网站停着时切换代码、安装依赖、构建，全部成功才启动网站并等健康检查通过。任一步失败网站保持停止，`status` 显示失败原因；修好后重新执行 `update`，或确认代码与依赖无误后 `sudo systemctl start guance-app`。更新期间网站不可用（通常一两分钟）。工作区有未提交改动时拒绝更新；两次 `update` 不能同时进行。
- **改配置**：改了 `server/.env` 或 `deploy/.env` 的值后重启对应服务；新填或清空 `QDRANT_BIN`、`EMBED_CMD` 后重新执行 `install`，以装上或停用、删除对应服务。卸载：`sudo systemctl disable --now guance-app guance-qdrant guance-embedding`，再删除 `/etc/systemd/system/guance-*.service`。

## WSL

1. **打开 systemd**（只需一次）：在 WSL 里编辑 `/etc/wsl.conf`，加入下面两行，然后在 Windows 的 PowerShell 执行 `wsl --shutdown`，再打开 WSL；`systemctl is-system-running` 显示 `running` 或 `degraded` 即可。
   ```ini
   [boot]
   systemd=true
   ```
2. **安装服务**：在 WSL 里按上面“首次准备”执行 `deploy/guance.sh install`。
3. **让 WSL 保持运行**：没有 `wsl.exe` 进程时 WSL 会在十几秒后关机，systemd 服务随之停止（实测打开 systemd 后也是这样，`wsl --exec true` 这类一次性命令不够）。在 Windows 的 PowerShell（必要时以管理员身份）执行一次下面的命令，注册一个登录后运行的任务：它在隐藏窗口里启动一个常驻的 `wsl.exe`，WSL 启动后 systemd 自动拉起已启用的服务。发行版不叫 Ubuntu 时改 `-d` 后的名字。
   ```powershell
   Register-ScheduledTask -TaskName 'Guance WSL' -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
     -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -WindowStyle Hidden -Command Start-Process wsl.exe -WindowStyle Hidden -ArgumentList '-d Ubuntu --exec sleep infinity'")
   ```
   立即生效：`Start-ScheduledTask 'Guance WSL'`。不要结束那个隐藏的 `wsl.exe`，也不要执行 `wsl --shutdown`，否则服务随 WSL 停止，直到下次登录。任务在用户登录后启动；需要开机后不登录也运行时，在任务计划程序里把该任务改为“不管用户是否登录都要运行”（需输入密码，未实测）。

## 备份

停止服务后一起备份 `DATA_DIR`、Qdrant 数据目录（或 Docker 卷 `guance-rag-backend_qdrant-data`）和 `server/.env`；只恢复其中一部分会出现文献与向量不一致，需要 `pnpm rag reindex`。启用沙箱时另按沙箱文档备份。

## 排查

| `status` 显示            | 先看                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `guance-app：activating` | 正在启动，或启动失败后在 5 秒重启间隔中；反复出现时看 `journalctl -u guance-app`（如 node 不在 PATH）        |
| `guance-app：failed`     | 配置有误（上方会列出原因）或 20 秒内停不下来；改正后 `sudo systemctl restart guance-app`                     |
| `guance-app：inactive`   | 被手动停止，或更新失败（下一行显示原因）                                                                     |
| `guance-qdrant：未安装`  | `deploy/.env` 没填 `QDRANT_BIN`，Qdrant 另行运行（如 Docker）；需要本机运行时填好后重新 `install`            |
| 网站：无响应             | `journalctl -u guance-app`；刚启动或刚更新时等十几秒                                                         |
| Qdrant：无响应           | `journalctl -u guance-qdrant`，或 `docker compose ... ps`；端口是否与 `QDRANT_URL` 一致                      |
| 向量服务：无响应         | `journalctl -u guance-embedding`；刚启动时要等模型加载完；显存不足时日志里有 OutOfMemory；维度是否与配置一致 |
| 校内模型：无响应         | 服务器是否在校园网内、能否访问 `CAMPUS_BASE_URL`；密钥是否有效                                               |
| `systemd 未运行`         | Linux 用 systemd 的发行版，或 WSL 按上文打开 systemd                                                         |

`status` 检查向量服务时用网站自己的出站代理设置、配置读取与向量客户端（含 `EMBEDDING_DIMENSIONS`），`server/.env` 按 Node 的规则读取（行尾注释、`export`、等号两侧空格），与网站实际请求一致。

## 迁移到学校服务器前需要确认

- 操作系统与权限：是否用 systemd；运行服务的账号能否使用 `sudo`（`install` 写入单元、`update` 停启网站时需要），或用 Docker 开机自启。
- 网络：服务器能否访问校内模型 `10.27.66.12`、能否访问 GitHub 与 npm（拉代码、装依赖）；访问者如何连到服务器（SSH 隧道，或待认证接入后的网址）。
- 算力：有无 NVIDIA 显卡跑 BGE-M3；没有时检索查询仍可用但更慢（未实测具体耗时），全量导入不宜在这样的服务器上做，改为从已有部署迁移数据。
- 磁盘：`DATA_DIR` 约 15 GB，另加 Qdrant 数据与备份空间。
- 多人使用：需要学校身份认证方式，确定后再接入 `server/auth.ts`。
