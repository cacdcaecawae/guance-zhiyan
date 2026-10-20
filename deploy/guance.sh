#!/usr/bin/env bash
# 管策智研一键部署脚本（Linux / WSL）。说明见 docs/DEPLOY.md。
#   deploy/guance.sh run              前台常驻：启动 Qdrant、向量服务（配置了才由本脚本启动）与网站，
#                                     任一进程退出 5 秒后重启；Ctrl+C 或 SIGTERM 时全部停止。同一仓库只运行一份
#   deploy/guance.sh status           守护进程、各服务健康检查与代码版本
#   deploy/guance.sh update [版本]    在临时工作树中安装并构建（默认 origin/main），成功后才切换并重启网站
#   deploy/guance.sh stop             停止 run 启动的全部服务
# 进程配置在 deploy/.env（从 deploy/.env.example 复制）；模型密钥、端口、数据目录等应用配置只在 server/.env。
set -uo pipefail
SELF=$(readlink -f "$0")
# 服务端按当前目录解析 dist/ 与相对的 DATA_DIR，pnpm rag 也在这里读同一份 server/.env，所以始终在仓库根目录运行
cd "$(dirname "$SELF")/.." || exit 1

# deploy/.env 只放进程配置，且不导出给服务进程。应用配置若写在这里，网站与 pnpm rag 会用不同的数据目录等设置
PROCESS_KEYS='PATH|QDRANT_BIN|QDRANT_STORAGE|EMBED_CMD|APP_MODE|LOG_DIR'
if [ -f deploy/.env ]; then
  misplaced=$(grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' deploy/.env |
    grep -vE "^[[:space:]]*(export[[:space:]]+)?($PROCESS_KEYS)=" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/=.*//')
  if [ -n "$misplaced" ]; then
    echo "deploy/.env 只放进程配置（${PROCESS_KEYS//|/、}）；请把 $(echo $misplaced | tr ' ' '、') 移到 server/.env。" >&2
    exit 1
  fi
  . deploy/.env
  export PATH
fi
LOG_DIR=${LOG_DIR:-deploy/logs}
mkdir -p "$LOG_DIR"
SERVICES=(qdrant embedding app)

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG_DIR/run.log"; }

# server/.env 的一项应用配置（取最后一处，去掉首尾引号）；环境变量中已有时以它为准，与 node --env-file 一致
setting() {
  local value
  value=$(printenv "$1") ||
    value=$(sed -n "s/^$1=//p" server/.env 2>/dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//")
  echo "${value:-${2:-}}"
}

# 进程组里是否还有本脚本启动、未退出的进程（僵尸进程不算）。服务以进程组运行，组长退出后子进程可能还在。
# 本脚本启动的进程都带 GUANCE_ROOT=仓库目录：进程号文件可能过时、号码被别的程序复用，没有这个标记的组不算、也不会被结束
group_alive() {
  local pid
  [ -n "$1" ] || return 1
  for pid in $(ps -e -o pid=,pgid=,stat= | awk -v g="$1" '$2 == g && $3 !~ /^Z/ { print $1 }'); do
    tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -qxF "GUANCE_ROOT=$PWD" && return 0
  done
  return 1
}

# 结束整个进程组：先 TERM，20 秒后仍有进程则 KILL，确认全部退出才返回成功
end_group() {
  group_alive "$1" || return 0
  kill -TERM -- "-$1" 2>/dev/null
  for _ in $(seq 20); do
    group_alive "$1" || return 0
    sleep 1
  done
  kill -KILL -- "-$1" 2>/dev/null
  for _ in $(seq 5); do
    group_alive "$1" || return 0
    sleep 1
  done
  return 1
}

# 记录在案、仍有进程存活的组：守护进程自身的组（含各服务的守护子 shell）与各服务的组
live_groups() {
  local name pid
  for name in run "${SERVICES[@]}"; do
    pid=$(cat "$LOG_DIR/$name.pid" 2>/dev/null)
    group_alive "$pid" && echo "$pid"
  done
}

run() {
  # 自成进程组，stop 才能连同守护子 shell 一起结束（终端前台与 systemd 下本来就是；从 wsl.exe 等非交互 shell 启动时不是）
  # 同时带上 GUANCE_ROOT 重新执行，让守护进程自身也有标记（export 不会改变已启动进程的环境记录）
  if [ "${GUANCE_ROOT:-}" != "$PWD" ]; then
    if [ "$(ps -o pgid= $$ | tr -d ' ')" = $$ ]; then
      GUANCE_ROOT=$PWD exec bash "$SELF" run
    fi
    GUANCE_ROOT=$PWD exec setsid bash "$SELF" run
  fi
  exec 9>"$LOG_DIR/run.lock"
  if ! flock -n 9 || [ -n "$(live_groups)" ]; then
    if kill -0 "$(cat "$LOG_DIR/run.pid" 2>/dev/null)" 2>/dev/null && group_alive "$(cat "$LOG_DIR/run.pid")"; then
      echo "已在运行（PID $(cat "$LOG_DIR/run.pid")）。查看状态：deploy/guance.sh status"
      exit 0
    fi
    echo "上次未正常停止的进程仍在运行，先执行 deploy/guance.sh stop。"
    exit 1
  fi
  echo $$ >"$LOG_DIR/run.pid"
  local subshells=()
  # 名称 命令…：在独立进程组中运行，退出后结束组内残留进程、5 秒后重启；收到停止信号时结束整个进程组
  supervise() {
    local name=$1
    shift
    (
      child=
      sleeper=
      trap 'kill "$sleeper" 2>/dev/null; end_group "$child"; exit 0' TERM INT
      while :; do
        log "启动 $name"
        # 关闭锁的文件描述符：服务进程不持有单实例锁
        setsid "$@" 9>&- >>"$LOG_DIR/$name.log" 2>&1 &
        child=$!
        echo "$child" >"$LOG_DIR/$name.pid"
        wait "$child"
        log "$name 已退出（退出码 $?），5 秒后重启"
        # 组长退出后子进程可能还占着端口或显存，先结束再重启
        end_group "$child"
        # 后台 sleep 再 wait：等待期间收到停止信号时立即处理
        sleep 5 &
        sleeper=$!
        wait "$sleeper"
      done
    ) &
    subshells+=($!)
  }
  trap 'trap - TERM INT; log "正在停止"; kill "${subshells[@]}" 2>/dev/null; wait; rm -f "$LOG_DIR"/*.pid; log "已全部停止"; exit 0' TERM INT

  if [ -n "${QDRANT_BIN:-}" ]; then
    : "${QDRANT_STORAGE:?设置了 QDRANT_BIN 时须同时设置 QDRANT_STORAGE（Qdrant 数据目录）}"
    # 下面切换到数据目录运行 Qdrant，相对路径先按仓库根目录解析成绝对路径；不含 / 的可执行文件名按 PATH 查找
    local storage bin=$QDRANT_BIN port
    storage=$(realpath -m "$QDRANT_STORAGE")
    [[ $bin == */* ]] && bin=$(realpath -m "$bin")
    port=$(setting QDRANT_URL http://127.0.0.1:6333)
    port=${port##*:}
    port=${port%%/*}
    [[ $port =~ ^[0-9]+$ ]] || port=6333
    mkdir -p "$storage"
    # Qdrant 默认监听所有网卡且不设密钥，这里限定本机；工作目录放在数据目录，避免在仓库里生成文件
    supervise qdrant env -C "$storage" QDRANT__SERVICE__HOST=127.0.0.1 \
      QDRANT__SERVICE__HTTP_PORT="$port" QDRANT__SERVICE__GRPC_PORT=$((port + 1)) \
      QDRANT__STORAGE__STORAGE_PATH="$storage" QDRANT__STORAGE__SNAPSHOTS_PATH="$storage/snapshots" \
      QDRANT__TELEMETRY_DISABLED=true "$bin"
  fi
  [ -n "${EMBED_CMD:-}" ] && supervise embedding bash -c "$EMBED_CMD"
  local mode=()
  [ "${APP_MODE:-local}" = local ] && mode=(--local)
  supervise app node --env-file-if-exists=server/.env --disable-warning=ExperimentalWarning \
    server/index.ts "${mode[@]}"
  log "已启动（$(git log -1 --format=%h 2>/dev/null)），日志在 $LOG_DIR；停止：Ctrl+C 或 deploy/guance.sh stop"
  wait
}

# 带可选密钥的 GET / POST：密钥用内建 printf 经管道交给 curl，不出现在任何进程的参数里
fetch_with_key() {
  local key=$1
  shift
  if [ -n "$key" ]; then
    printf 'Authorization: Bearer %s\n' "$key" | curl -fsS -H @- "$@"
  else
    curl -fsS "$@"
  fi
}
embedding_ok() {
  fetch_with_key "$(setting EMBEDDING_API_KEY)" -m 60 -H 'Content-Type: application/json' \
    -d "{\"model\":\"$(setting EMBEDDING_MODEL)\",\"input\":[\"健康检查\"]}" "$(setting EMBEDDING_URL)"
}
campus_ok() {
  fetch_with_key "$(setting CAMPUS_API_KEY)" -m 10 "$(setting CAMPUS_BASE_URL http://10.27.66.12 | sed 's#/*$##')/v1/models"
}

status() {
  local pid
  pid=$(cat "$LOG_DIR/run.pid" 2>/dev/null)
  if group_alive "$pid" && kill -0 "$pid" 2>/dev/null; then
    echo "守护进程：运行中（PID $pid）"
  elif [ -n "$(live_groups)" ]; then
    echo "守护进程：已异常退出，仍有遗留进程，执行 deploy/guance.sh stop 清理"
  else
    echo "守护进程：未运行"
  fi
  check() {
    local name=$1
    shift
    if "$@" >/dev/null 2>&1; then echo "$name：正常"; else echo "$name：无响应（日志：$LOG_DIR）"; fi
  }
  check 网站 curl -fsS -m 5 "http://127.0.0.1:$(setting PORT 3001)/api/health"
  check Qdrant curl -fsS -m 5 "$(setting QDRANT_URL http://127.0.0.1:6333 | sed 's#/*$##')/readyz"
  if [ -z "$(setting EMBEDDING_URL)" ]; then
    echo "向量服务：未配置（server/.env 的 EMBEDDING_URL 为空，文献库不可用）"
  else
    check 向量服务 embedding_ok
  fi
  [ -n "$(setting CAMPUS_API_KEY)" ] && check 校内模型 campus_ok
  echo "代码版本：$(git log -1 --format='%h %s' 2>/dev/null)"
}

update() {
  local ref=${1:-origin/main} stage=deploy/.update previous
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "工作区有未提交的改动，先提交或撤销后再更新（模板文件请复制后修改副本，不要改仓库里的）。"
    exit 1
  fi
  previous=$(git rev-parse HEAD)
  git worktree remove --force "$stage" 2>/dev/null
  git worktree prune
  # 先在临时工作树里安装并构建，失败时正在使用的代码、依赖与 dist/ 都不动
  if ! { git fetch origin && git worktree add -q --detach "$stage" "$ref" &&
    (cd "$stage" && pnpm install --frozen-lockfile --prefer-offline && pnpm build); }; then
    git worktree remove --force "$stage" 2>/dev/null
    log "更新到 $ref 失败（构建未通过），仍为 $(git log -1 --format=%h)，网站未重启"
    exit 1
  fi
  # 构建通过后切换：代码与依赖切到新版本，失败则退回原版本；dist/ 最后整体替换
  if ! { git checkout -q --detach "$(git -C "$stage" rev-parse HEAD)" && pnpm install --frozen-lockfile --prefer-offline; }; then
    git worktree remove --force "$stage" 2>/dev/null
    if git checkout -q --detach "$previous" && pnpm install --frozen-lockfile --prefer-offline; then
      log "切换到 $ref 失败，已退回 $(git log -1 --format=%h)，网站未重启"
    else
      log "切换到 $ref 失败，且未能退回 ${previous:0:7}：依赖可能不完整，修复前不要重启网站"
    fi
    exit 1
  fi
  rm -rf dist.old && { [ ! -d dist ] || mv dist dist.old; } && mv "$stage/dist" dist && rm -rf dist.old
  git worktree remove --force "$stage"
  log "已更新到 $(git log -1 --format='%h %s')"
  local pid
  pid=$(cat "$LOG_DIR/app.pid" 2>/dev/null)
  if group_alive "$(cat "$LOG_DIR/run.pid" 2>/dev/null)" && group_alive "$pid"; then
    kill -TERM -- "-$pid"
    echo "网站将在约 5 秒后以新版本重启。"
  else
    echo "服务未在运行，执行 deploy/guance.sh run 启动。"
  fi
}

stop() {
  local pid groups group failed= running=
  pid=$(cat "$LOG_DIR/run.pid" 2>/dev/null)
  if group_alive "$pid" && kill -0 "$pid" 2>/dev/null; then
    running=1
    # 守护进程收到 TERM 后逐个结束各服务进程组，最长约 25 秒
    kill -TERM "$pid"
    for _ in $(seq 40); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
  fi
  # 守护进程异常退出、或停止后仍有残留时，直接结束记录在案的各进程组（守护进程的组在前，先结束会重启服务的子 shell）
  groups=$(live_groups)
  if [ -z "$groups" ]; then
    rm -f "$LOG_DIR"/*.pid
    [ -n "$running" ] && echo "已停止。" || echo "未在运行。"
    return
  fi
  for group in $groups; do end_group "$group" || failed=1; done
  if [ -n "$failed" ] || [ -n "$(live_groups)" ]; then
    echo "仍有进程未能结束（进程组：$(live_groups | tr '\n' ' ')），请查看 $LOG_DIR/run.log。"
    exit 1
  fi
  rm -f "$LOG_DIR"/*.pid
  echo "已停止（并结束了遗留进程）。"
}

case "${1:-}" in
  run) run ;;
  status) status ;;
  update) update "${2:-}" ;;
  stop) stop ;;
  *)
    sed -n '2,8p' "$SELF" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
