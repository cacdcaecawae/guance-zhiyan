# ADR 0005：按会话隔离的 Bash 与文件执行环境

日期：2026-09-24 · 状态：已采纳（用户确认方案并要求开始实现）

本决定替代 ADR 0004 中“只调用内置工具、不开放 Bash”的限制；身份、存储与 DSH 循环的决定继续有效。

## 决定

- 保留 Node.js / TypeScript 后端及 DSH Agent Loop，复用同版本 `tool-bash`、`tool-fs`。仅在明确配置沙箱服务时装载命令与工作区工具，连接失败不会降级为宿主机执行。
- 使用自部署 OpenSandbox，SDK 固定 1.1.0。管理服务固定上游提交 `2f5e56ab15846e661da53fb24a4caa4ec3f2008d`，包含 `publish_host` 修复；原版 1.1.0 默认公开绑定执行端口，不用于本配置。
- 每会话一个按需创建、跨轮次复用的容器和独立持久卷。SQLite 保存会话与远端实例归属；命令与文件接口只由后端提供用户、会话标识。模型不能指定沙箱 ID、挂载宿主机路径或选择执行身份。
- Bash、文件读写均发生在同一容器。文件工具由容器内 worker 复用 DSH `fs-local` 的路径、文本、版本和原子编辑行为。宿主机不执行模型代码。
- 命令以 uid/gid 1000 运行。沙箱内自动执行，不逐条确认，也没有扩大到宿主机的权限通道。单会话停止销毁整个容器，以终止脱离进程组的后台程序；工作区卷保留。
- 部署使用单台 Linux + Docker。容量达到配置值后等待或回收空闲实例；CPU/内存按实例限制，进程数由管理服务配置。Docker named volume 没有 SDK 磁盘硬配额；必须由部署主机配置文件系统/卷配额，不能把 SDK 的容量声明当作已强制执行。
- OpenSandbox 默认允许工作负载访问自身 execd 管理端口。复用其 egress 镜像，增加独立 nftables 表，禁止 uid 1000 访问 execd 44772 和 egress 18080；规则先于上游 loopback 放行规则执行。出站使用 `dns+nft` 拒绝私网和配置的管理 IP；不把 API 密钥放入工作负载环境。
- 任意格式产物通过显式 `export_file` 发布为不可变下载副本，现有 `create_file` 同时写入工作区。下载继续检查用户归属，不公开沙箱管理 API。未导出的临时文件不自动显示为附件。
- 首版不提供子 Agent、长期后台任务管理、多实例调度、Kubernetes、Office 在线预览、账号或学校 SSO 实现。

## 代价与验收

新增独立沙箱管理服务与工具镜像；备份增加会话工作区卷。应用仍是单进程，会话权限不等同于身份认证，学校认证继续待定。

受控模型与真实 SDK 协议测试覆盖按需创建、归属校验、原生工具循环、导出、停止与重建；容器内 DSH 文件 worker 单独验证版本保护与原子编辑。`pnpm test:sandbox` 对实际 Linux/Docker 服务验证用户环境隔离、控制接口不可达、持久化、文档生成和后台进程终止。未运行真实容器测试时须明确报告，不能用协议替身声称验证了内核隔离。

## 依据

- [DSH 执行环境接口](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/sandbox/sandbox/README.md)
- [OpenSandbox SDK](https://github.com/opensandbox-group/OpenSandbox/tree/release-1.1.0/sdks/sandbox/javascript)
- [绑定地址修复](https://github.com/opensandbox-group/OpenSandbox/commit/2f5e56ab15846e661da53fb24a4caa4ec3f2008d)
