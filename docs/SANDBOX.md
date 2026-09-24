# 会话沙箱部署

使用单台 Linux Docker 主机。应用后端与沙箱管理服务部署在同一台机器；Windows Docker Desktop 不属于这份生产部署配置。普通聊天无需此服务。执行环境服务不能代替学校登录，当前本机免登录入口不能对外开放。

## 构建与启动

在仓库根目录执行：

```bash
docker build -t guance-workspace:1 -f server/sandbox/Dockerfile .
docker build -t guance-egress:1 -f server/sandbox/egress.Dockerfile .
```

工作区镜像预装 Bash、Node.js、Python、python-docx、openpyxl、python-pptx、ReportLab 和中文字体。`/workspace` 属于 uid/gid 1000，Docker 新建卷继承目录权限。文件 worker 与 DSH 依赖位于只允许 root 修改的 `/opt/gczy`。

生成管理密钥，存放在被 Git 忽略的文件中（不要提交或输出密钥）：

```bash
umask 077
printf 'SANDBOX_API_KEY=%s\n' "$(openssl rand -hex 32)" > server/sandbox/.env
docker compose --env-file server/sandbox/.env -f server/sandbox/compose.yaml up -d --build
```

管理镜像从固定上游提交构建，可能需要数分钟。配置位于 `server/sandbox/server.toml`：管理端与执行端口均绑定 127.0.0.1；管理服务使用 host 网络，被创建的工作负载仍使用 bridge 网络。Docker socket 只交给管理服务。

在应用 `server/.env` 设置：

```dotenv
SANDBOX_URL=http://127.0.0.1:8080
SANDBOX_API_KEY=与上面的私有文件相同的密钥
SANDBOX_IMAGE=guance-workspace:1
SANDBOX_CAPACITY=4
SANDBOX_CPU=1
SANDBOX_MEMORY=1Gi
SANDBOX_IDLE_SECONDS=300
SANDBOX_DENY_CIDRS=部署主机与管理入口的实际公网IPv4或CIDR，逗号分隔
```

最后一项按实际部署填写；没有公网地址时留空。重启应用后装载原生 `bash`、`read`、`write`、`edit` 和 `export_file`，原联网、文档生成工具继续可用。未设置 URL 时不装载这些工具；错误连接会明确失败，不转用本地 shell。

## 文件与执行

- 同一会话复用沙箱；不同用户及不同会话各用独立卷 `gczy-<session UUID>`。数据库控制归属，模型不能选择卷或宿主机挂载。
- 第一次调用才启动容器；默认最多 4 个容器。容量满时优先回收空闲容器，否则等待，等待可取消。普通聊天不受此容量限制。
- 空闲约 5 分钟回收容器，活动实例定期续期。停止生成销毁当前会话容器及其后台进程；工作区卷与已导出附件保留。应用重启先清理数据库记录的旧实例，避免旧进程与新执行同时写入卷。
- `/workspace` 持久化，`/tmp`、内存和进程不持久化。`create_file` 产生的文档同时进入工作区；Bash 生成的任意格式文件需调用 `export_file` 发布下载副本。修改工作区文件不会修改已下载附件。
- Bash 默认单次等待 120 秒，可通过工具 `timeoutMs` 指定；超时销毁该会话容器。命令输出保留最多 1 MiB 的尾部并明确标记截断；这不限制模型回答长度。需要完整大输出时写入工作区文件后导出。
- 每个导出文件及每位用户已有下载附件沿用 50 MiB 限额；这不是工作区磁盘配额。
- 任意导出的 Word/Excel 属于不可信压缩文件，`read_file` 在沙箱内用 Python 解析；未启用沙箱时明确拒绝解析。后端只直接解析自有生成器产生并在数据库标记的 Office 文件，避免高压缩文件突破容器内存配额。

## 部署边界

CPU、内存限制来自容器配置，进程数默认 256。**Docker named volume 没有自动磁盘硬配额**。多人上线前须为 Docker 卷所在存储配置主机文件系统/卷驱动配额和容量告警；仅使用本仓库默认配置不能声称磁盘耗尽已隔离。备份应用 `DATA_DIR`、沙箱管理状态卷及所有 `gczy-*` 工作区卷，不能只备份 SQLite。

egress 使用 `dns+nft`，拒绝私网、云元数据和额外配置的管理地址，关闭 IPv6。定制镜像仅增加一条按 uid 阻断控制端口的规则，防止工作负载通过容器内 execd API 请求 root 操作。不得换成未加规则的官方 egress 镜像后继续声称隔离配置相同。

不向容器注入 DeepSeek、千问或沙箱管理密钥，不挂应用代码、数据库、其他用户目录或 Docker socket。后端访问管理 API，浏览器只访问本项目 API。容器共享宿主机内核，当前部署面向可信组织内的研究者；公开运行恶意代码需要另行评估更强的运行时隔离。

## 验证与维护

```bash
pnpm test:sandbox
```

该命令要求真实服务，缺少配置直接失败，不跳过。它使用独立测试账号/会话，验证文件隔离、控制端口阻断、文档生成、容器重建后文件保留、停止脱离进程组的后台程序；结束只清理本次创建的卷。CI 的 `Sandbox acceptance` 在 Linux 上构建部署并执行同一验证；常规 `pnpm check` 使用真实 SDK 对接受控 HTTP 协议服务，不能代替内核隔离验收。

停止管理服务：`docker compose --env-file server/sandbox/.env -f server/sandbox/compose.yaml down`。先停止应用任务；不要运行 `docker volume prune`，会误删用户工作区。正常应用退出会清理活动容器；非正常退出还有服务端 TTL 回收，下一次启动也会检查旧记录。
