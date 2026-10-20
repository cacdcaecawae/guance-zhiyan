#!/usr/bin/env bash
# 管策智研一键部署脚本（Linux / WSL）。说明见 docs/DEPLOY.md。
#   deploy/guance.sh run              前台常驻：启动 Qdrant、向量服务（配置了才由本脚本启动）与网站，
#                                     任一进程退出 5 秒后重启；Ctrl+C 或 SIGTERM 时全部停止。同一仓库只运行一份
#   deploy/guance.sh status           守护进程、各服务健康检查与代码版本
#   deploy/guance.sh update [版本]    拉取并构建（默认 origin/main），成功后只重启网站
#   deploy/guance.sh stop             停止 run 启动的全部服务
# 进程配置在 deploy/.env（从 deploy/.env.example 复制）；模型密钥、端口、数据目录等应用配置仍在 server/.env。
set -uo pipefail
SELF=$(readlink -f "$0")
# 服务端按当前目录解析 dist/ 与相对的 DATA_DIR，所以始终在仓库根目录运行
cd "$(dirname "$SELF")/.." || exit 1
if [ -f deploy/.env ]; then
  set -a
  . deploy/.env
  set +a
fi
LOG_DIR=${LOG_DIR:-deploy/logs}
mkdir -p "$LOG_DIR"

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG_DIR/run.log"; }

# server/.env 的一项配置：取最后一处并去掉首尾引号；环境（含 deploy/.env）里已有同名变量时以它为准，
# 与 node --env-file 的优先级一致
setting() {
  local value=${!1:-}
  [ -n "$value" ] ||
    value=$(sed -n "s/^$1=//p" server/.env 2>/dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//")
  echo "${value:-${2:-}}"
}

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

SERVICES=(qdrant embedding app)
# 上次异常结束（守护进程被强制结束）后仍在运行的服务进程号
orphans() {
  local name pid
  for name in "${SERVICES[@]}"; do
    pid=$(cat "$LOG_DIR/$name.pid" 2>/dev/null)
    alive "$pid" && echo "$pid"
  done
}

run() {
  # 自成进程组，stop 才能连同守护子进程一起结束（终端前台与 systemd 下本来就是；从 wsl.exe 等非交互 shell 启动时不是）
  [ "$(ps -o pgid= $$ | tr -d ' ')" = $$ ] || exec setsid bash "$SELF" run
  exec 9>"$LOG_DIR/run.lock"
  if ! flock -n 9 || [ -n "$(orphans)" ]; then
    if alive "$(cat "$LOG_DIR/run.pid" 2>/dev/null)"; then
      echo "已在运行（PID $(cat "$LOG_DIR/run.pid")）。查看状态：deploy/guance.sh status"
      exit 0
    fi
    # 锁被遗留的守护子进程占着，或服务进程还在：重新启动会抢端口
    echo "上次未正常停止的进程仍在运行，先执行 deploy/guance.sh stop。"
    exit 1
  fi
  echo $$ >"$LOG_DIR/run.pid"
  local groups=()
  # 名称 命令…：在独立进程组中运行，退出后 5 秒重启。停止时结束整个进程组（含向量服务这类由 shell 拉起的子进程），
  # 20 秒内未退出则强制结束
  supervise() {
    local name=$1
    shift
    (
      child=
      stop() {
        alive "$child" && kill -TERM -- "-$child" 2>/dev/null
        for _ in $(seq 20); do
          alive "$child" || exit 0
          sleep 1
        done
        kill -KILL -- "-$child" 2>/dev/null
        exit 0
      }
      trap stop TERM INT
      while :; do
        log "启动 $name"
        # 关闭锁的文件描述符：服务进程不持有单实例锁，守护进程异常结束后可以清理并重新启动
        setsid "$@" 9>&- >>"$LOG_DIR/$name.log" 2>&1 &
        child=$!
        echo "$child" >"$LOG_DIR/$name.pid"
        wait "$child"
        log "$name 已退出（退出码 $?），5 秒后重启"
        # 后台 sleep 再 wait：等待期间收到停止信号时立即处理，不必等满 5 秒
        sleep 5 &
        wait $!
      done
    ) &
    groups+=($!)
  }
  trap 'trap - TERM INT; log "正在停止"; kill "${groups[@]}" 2>/dev/null; wait; rm -f "$LOG_DIR"/*.pid; log "已全部停止"; exit 0' TERM INT

  if [ -n "${QDRANT_BIN:-}" ]; then
    : "${QDRANT_STORAGE:?设置了 QDRANT_BIN 时须同时设置 QDRANT_STORAGE（Qdrant 数据目录）}"
    local port=$(setting QDRANT_URL http://127.0.0.1:6333)
    port=${port##*:}
    port=${port%%/*}
    [[ $port =~ ^[0-9]+$ ]] || port=6333
    mkdir -p "$QDRANT_STORAGE"
    # Qdrant 默认监听所有网卡且不设密钥，这里限定本机；工作目录放在数据目录，避免在仓库里生成文件
    supervise qdrant env -C "$QDRANT_STORAGE" QDRANT__SERVICE__HOST=127.0.0.1 \
      QDRANT__SERVICE__HTTP_PORT="$port" QDRANT__SERVICE__GRPC_PORT=$((port + 1)) \
      QDRANT__STORAGE__STORAGE_PATH="$QDRANT_STORAGE" \
      QDRANT__STORAGE__SNAPSHOTS_PATH="$QDRANT_STORAGE/snapshots" \
      QDRANT__TELEMETRY_DISABLED=true "$QDRANT_BIN"
  fi
  [ -n "${EMBED_CMD:-}" ] && supervise embedding bash -c "$EMBED_CMD"
  local mode=()
  [ "${APP_MODE:-local}" = local ] && mode=(--local)
  supervise app node --env-file-if-exists=server/.env --disable-warning=ExperimentalWarning \
    server/index.ts "${mode[@]}"
  log "已启动（$(git log -1 --format=%h 2>/dev/null)），日志在 $LOG_DIR；停止：Ctrl+C 或 deploy/guance.sh stop"
  wait
}

status() {
  local pid
  pid=$(cat "$LOG_DIR/run.pid" 2>/dev/null)
  if alive "$pid"; then echo "守护进程：运行中（PID $pid）"; else echo "守护进程：未运行"; fi
  check() {
    local name=$1
    shift
    if "$@" >/dev/null 2>&1; then echo "$name：正常"; else echo "$name：无响应（日志：$LOG_DIR）"; fi
  }
  check 网站 curl -fsS -m 5 "http://127.0.0.1:$(setting PORT 3001)/api/health"
  check Qdrant curl -fsS -m 5 "$(setting QDRANT_URL http://127.0.0.1:6333 | sed 's#/*$##')/readyz"
  local embedding
  embedding=$(setting EMBEDDING_URL)
  if [ -z "$embedding" ]; then
    echo "向量服务：未配置（server/.env 的 EMBEDDING_URL 为空，文献库不可用）"
  else
    # 密钥经标准输入交给 curl，不出现在进程列表里
    check 向量服务 sh -c 'printf "Authorization: Bearer %s\n" "$1" |
      curl -fsS -m 60 -H @- -H "Content-Type: application/json" -d "$2" "$3"' _ \
      "$(setting EMBEDDING_API_KEY)" "{\"model\":\"$(setting EMBEDDING_MODEL)\",\"input\":[\"健康检查\"]}" "$embedding"
  fi
  local campus
  campus=$(setting CAMPUS_API_KEY)
  [ -n "$campus" ] && check 校内模型 sh -c 'printf "Authorization: Bearer %s\n" "$1" |
    curl -fsS -m 10 -H @- "$2/v1/models"' _ "$campus" "$(setting CAMPUS_BASE_URL http://10.27.66.12)"
  echo "代码版本：$(git log -1 --format='%h %s' 2>/dev/null)"
}

update() {
  local ref=${1:-origin/main}
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "工作区有未提交的改动，先提交或撤销后再更新。"
    exit 1
  fi
  # ponytail: 构建直接覆盖 dist/，构建中途失败时正在运行的网站可能读到不完整的页面；需要时改为先构建到临时目录再替换
  if ! { git fetch origin && git checkout -q --detach "$ref" && pnpm install --frozen-lockfile && pnpm build; }; then
    log "更新到 $ref 失败，网站未重启"
    exit 1
  fi
  log "已更新到 $(git log -1 --format='%h %s')"
  local pid
  pid=$(cat "$LOG_DIR/app.pid" 2>/dev/null)
  if alive "$pid"; then
    kill -TERM -- "-$pid"
    echo "网站将在约 5 秒后以新版本重启。"
  else
    echo "服务未在运行，执行 deploy/guance.sh run 启动。"
  fi
}

stop() {
  local pid left
  pid=$(cat "$LOG_DIR/run.pid" 2>/dev/null)
  if ! alive "$pid"; then
    left=$(orphans)
    if [ -z "$left" ]; then
      echo "未在运行。"
      return
    fi
    # 守护进程已异常结束：结束它留下的守护子进程（同一进程组）与各服务进程组
    [ -n "$pid" ] && kill -TERM -- "-$pid" 2>/dev/null
    for pid in $left; do kill -TERM -- "-$pid" 2>/dev/null; done
    sleep 3
    for pid in $left; do kill -KILL -- "-$pid" 2>/dev/null; done
    rm -f "$LOG_DIR"/*.pid
    echo "已结束上次遗留的服务进程。"
    return
  fi
  kill -TERM "$pid"
  for _ in $(seq 30); do
    alive "$pid" || {
      echo "已停止。"
      return
    }
    sleep 1
  done
  echo "30 秒内未停止，请查看 $LOG_DIR/run.log。"
  exit 1
}

case "${1:-}" in
  run) run ;;
  status) status ;;
  update) update "${2:-}" ;;
  stop) stop ;;
  *)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
