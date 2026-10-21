#!/usr/bin/env bash
# 管策智研部署脚本（Linux / WSL，由 systemd 守护）。说明见 docs/DEPLOY.md。
#   deploy/guance.sh install          生成 systemd 服务（Qdrant 与向量服务在 deploy/.env 配置了才装，网站总是装），设为开机自启并（重新）启动，
#                                     等各服务运行且健康检查通过才报成功
#   deploy/guance.sh status           各服务的运行状态、健康检查与代码版本
#   deploy/guance.sh units <目录>     只把 systemd 单元生成到目录（检查用），不安装
# 停止、重启与日志用 systemctl / journalctl，如 sudo systemctl restart guance-app、journalctl -u guance-app；更新步骤见 docs/DEPLOY.md。
# qdrant、embedding、app 是 systemd 调用的服务入口，也可在前台单独运行排查。
# 进程配置在 deploy/.env（从 deploy/.env.example 复制）；模型密钥、端口、数据目录等应用配置只在 server/.env。
set -uo pipefail
SELF=$(readlink -f "$0")
# 服务端按当前目录解析 dist/ 与相对的 DATA_DIR，pnpm rag 也在这里读同一份 server/.env，所以始终在仓库根目录运行
cd "$(dirname "$SELF")/.." || exit 1

# deploy/.env 只放进程配置，且不导出给服务进程。应用配置若写在这里，网站与 pnpm rag 会用不同的数据目录等设置
PROCESS_KEYS='PATH|QDRANT_BIN|QDRANT_STORAGE|EMBED_CMD|APP_MODE'
errors=()
if [ -f deploy/.env ]; then
  misplaced=$(grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' deploy/.env |
    grep -vE "^[[:space:]]*(export[[:space:]]+)?($PROCESS_KEYS)=" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/=.*//')
  [ -z "$misplaced" ] ||
    errors+=("deploy/.env 只放进程配置（${PROCESS_KEYS//|/、}）；请把 $(echo $misplaced | tr ' ' '、') 移到 server/.env。")
  . deploy/.env || errors+=("deploy/.env 读取失败（见上面的报错），请改正后再执行。")
  export PATH
fi
case "${APP_MODE:-local}" in
  local | server) ;;
  *) errors+=("APP_MODE 只能是 local 或 server（现为 $APP_MODE）。") ;;
esac
[ -z "${QDRANT_BIN:-}" ] || [ -n "${QDRANT_STORAGE:-}" ] ||
  errors+=("设置了 QDRANT_BIN 时须同时设置 QDRANT_STORAGE（Qdrant 数据目录）。")
# 配置有误时 status 照常执行并显示问题；服务入口以 78 退出（单元里 RestartPreventExitStatus=78，systemd 不再反复重启）
if [ ${#errors[@]} -gt 0 ]; then
  printf '%s\n' "${errors[@]}" >&2
  case "${1:-}" in status) ;; qdrant | embedding | app) exit 78 ;; *) exit 1 ;; esac
fi

# server/.env 的一项应用配置，用 Node 自己的解析（行尾注释、export、引号、等号两侧空格与网站读到的一致）；
# 环境变量中已有时以它为准，与 node --env-file 一致
setting() {
  local value
  value=$(printenv "$1") ||
    value=$(node -e 'try { process.stdout.write(require("node:util").parseEnv(
      require("node:fs").readFileSync("server/.env", "utf8"))[process.argv[1]] ?? "") } catch {}' "$1")
  echo "${value:-${2:-}}"
}

# ---- 服务入口：exec 成服务进程本身，systemd 按控制组管理它和它的子进程 ----
qdrant() {
  [ -n "${QDRANT_BIN:-}" ] || {
    echo "deploy/.env 未设置 QDRANT_BIN。" >&2
    exit 78
  }
  local storage bin=$QDRANT_BIN port
  # 下面切换到数据目录运行 Qdrant，相对路径先按仓库根目录解析成绝对路径；不含 / 的可执行文件名按 PATH 查找
  storage=$(realpath -m "$QDRANT_STORAGE")
  [[ $bin == */* ]] && bin=$(realpath -m "$bin")
  port=$(setting QDRANT_URL http://127.0.0.1:6333)
  port=${port##*:}
  port=${port%%/*}
  [[ $port =~ ^[0-9]+$ ]] || port=6333
  mkdir -p "$storage" && cd "$storage" || exit 1
  # Qdrant 默认监听所有网卡且不设密钥，这里限定本机；工作目录放在数据目录，避免在仓库里生成文件
  QDRANT__SERVICE__HOST=127.0.0.1 QDRANT__SERVICE__HTTP_PORT=$port QDRANT__SERVICE__GRPC_PORT=$((port + 1)) \
    QDRANT__STORAGE__STORAGE_PATH=$storage QDRANT__STORAGE__SNAPSHOTS_PATH=$storage/snapshots \
    QDRANT__TELEMETRY_DISABLED=true exec "$bin"
}
embedding() {
  [ -n "${EMBED_CMD:-}" ] || {
    echo "deploy/.env 未设置 EMBED_CMD。" >&2
    exit 78
  }
  exec bash -c "$EMBED_CMD"
}
app() {
  local mode=()
  [ "${APP_MODE:-local}" = local ] && mode=(--local)
  exec node --env-file-if-exists=server/.env --disable-warning=ExperimentalWarning server/index.ts "${mode[@]}"
}

# 由 systemd 管理的服务：Qdrant、向量服务只在 deploy/.env 配置了运行方式时才有
services() {
  [ -z "${QDRANT_BIN:-}" ] || echo qdrant
  [ -z "${EMBED_CMD:-}" ] || echo embedding
  echo app
}

units() {
  local dir=$1 name deps
  case $PWD in
    *[[:space:]\\\"\'%\$]*)
      echo "仓库路径含空格或 \\ \" ' % \$ 等字符，不能直接写进 systemd 单元：$PWD" >&2
      return 1
      ;;
  esac
  mkdir -p "$dir" || return 1
  deps=$(services | grep -vx app | sed 's/.*/guance-&.service/' | paste -sd ' ')
  for name in $(services); do
    {
      echo '[Unit]'
      case $name in
        qdrant) echo "Description=管策智研 Qdrant 向量库（$PWD）" ;;
        embedding) echo "Description=管策智研向量服务（$PWD）" ;;
        app)
          echo "Description=管策智研网站（$PWD）"
          # 先起 Qdrant 与向量服务；它们不可用时网站照常运行，文献库检索报错，恢复后无需重启网站
          [ -z "$deps" ] || printf 'After=%s\nWants=%s\n' "$deps" "$deps"
          ;;
      esac
      cat <<EOF

[Service]
User=$(id -un)
WorkingDirectory=$PWD
ExecStart=$PWD/deploy/guance.sh $name
Restart=always
RestartSec=5
# 配置有误时入口以 78 退出：不再反复重启，status 会显示原因
RestartPreventExitStatus=78
# 停止时 systemd 结束整个控制组（含子进程）；20 秒内未退出的强制结束
TimeoutStopSec=20
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
    } >"$dir/guance-$name.service"
  done
}

declare -A LABEL=([qdrant]=Qdrant [embedding]=向量服务 [app]=网站)
# 等已安装的每个服务都在运行且通过各自的健康检查（与 status 同一套），约 3 分钟（向量服务加载模型较慢）；
# 有服务启动即退出（failed，或在自动重启的间隔中）时不再等。未就绪的逐个报出并返回失败
wait_ready() {
  local name state pending crashed deadline=$((SECONDS + 180))
  while :; do
    pending= crashed=
    for name in $(services); do
      state=$(systemctl is-active "guance-$name")
      if [ "$state" = failed ] || [ "$(systemctl show -p SubState --value "guance-$name")" = auto-restart ]; then
        crashed+=" $name"
      elif [ "$state" != active ] || ! "${name}_ok" >/dev/null 2>&1; then
        pending+=" $name"
      fi
    done
    [ -z "$crashed$pending" ] && return 0
    [ -n "$crashed" ] || ((SECONDS >= deadline)) && break
    sleep 3
  done
  for name in $crashed; do echo "${LABEL[$name]}（guance-$name）启动后退出，查看 journalctl -u guance-$name" >&2; done
  for name in $pending; do echo "${LABEL[$name]}（guance-$name）约 3 分钟内未就绪，查看 journalctl -u guance-$name" >&2; done
  return 1
}

systemd_ready() {
  [ -d /run/systemd/system ] && command -v systemctl >/dev/null
}

install_units() {
  local dir name all=(qdrant embedding app) wanted
  systemd_ready || {
    echo "本机没有运行 systemd，无法安装服务；WSL 先按 docs/DEPLOY.md 打开 systemd。" >&2
    exit 1
  }
  dir=$(mktemp -d)
  units "$dir" || exit 1
  wanted=$(services | sed 's/.*/guance-&/' | tr '\n' ' ')
  echo "以下步骤需要管理员权限（sudo）：写入 /etc/systemd/system/ 下的 $wanted单元，设为开机自启并（重新）启动。"
  # deploy/.env 去掉了 QDRANT_BIN 或 EMBED_CMD 时，之前装的对应服务一并停用并删除
  for name in "${all[@]}"; do
    if [ ! -e "$dir/guance-$name.service" ] && [ -e "/etc/systemd/system/guance-$name.service" ]; then
      sudo systemctl disable --now "guance-$name" && sudo rm "/etc/systemd/system/guance-$name.service" || exit 1
    fi
  done
  # shellcheck disable=SC2086 # 单元名不含空格
  if ! { sudo install -m 644 "$dir"/*.service /etc/systemd/system/ && sudo systemctl daemon-reload &&
    sudo systemctl enable $wanted && sudo systemctl restart $wanted; }; then
    rm -rf "$dir"
    echo "安装失败（见上面的报错）。" >&2
    exit 1
  fi
  rm -rf "$dir"
  wait_ready || {
    echo "已安装 $wanted并设为开机自启，但上面的服务未正常运行。" >&2
    exit 1
  }
  echo "已安装并启动：$wanted（开机自启），各服务健康检查通过。查看状态：deploy/guance.sh status"
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
# 健康检查：status 与 install 共用
app_ok() { curl -fsS -m 5 "http://127.0.0.1:$(setting PORT 3001)/api/health"; }
qdrant_ok() { curl -fsS -m 5 "$(setting QDRANT_URL http://127.0.0.1:6333 | sed 's#/*$##')/readyz"; }
# 用网站自己的网络设置（出站代理）、配置读取与向量客户端发同样的请求（含维度、密钥），并按网站的规则校验返回的条数与维度
embedding_ok() {
  node --env-file-if-exists=server/.env --disable-warning=ExperimentalWarning --input-type=module -e "
    import { configureNetwork } from './server/network.ts'
    import { ragConfig } from './server/rag.ts'
    import { Embeddings } from './server/rag-embedding.ts'
    const disposeNetwork = await configureNetwork()
    try {
      await new Embeddings(ragConfig().embedding).embed(['健康检查'], undefined, 0)
    } finally {
      await disposeNetwork()
    }"
}
campus_ok() {
  fetch_with_key "$(setting CAMPUS_API_KEY)" -m 10 "$(setting CAMPUS_BASE_URL http://10.27.66.12 | sed 's#/*$##')/v1/models"
}

status() {
  local name
  if systemd_ready; then
    for name in qdrant embedding app; do
      if [ "$(systemctl show -p LoadState --value "guance-$name" 2>/dev/null)" = loaded ]; then
        echo "guance-$name：$(systemctl is-active "guance-$name")"
      else
        echo "guance-$name：未安装"
      fi
    done
  else
    echo "systemd 未运行：各服务没有被守护"
  fi
  # 名称 单元 命令…
  check() {
    local label=$1 unit=$2
    shift 2
    if "$@" >/dev/null 2>&1; then echo "$label：正常"; else echo "$label：无响应（由本机管理时看 journalctl -u $unit）"; fi
  }
  check 网站 guance-app app_ok
  check Qdrant guance-qdrant qdrant_ok
  if [ -z "$(setting EMBEDDING_URL)" ]; then
    echo "向量服务：未配置（server/.env 的 EMBEDDING_URL 为空，文献库不可用）"
  else
    check 向量服务 guance-embedding embedding_ok
  fi
  [ -n "$(setting CAMPUS_API_KEY)" ] && check 校内模型 - campus_ok
  echo "代码版本：$(git log -1 --format='%h %s' 2>/dev/null)"
}

case "${1:-}" in
  install) install_units ;;
  status) status ;;
  units) units "${2:?用法：deploy/guance.sh units <目录>}" ;;
  qdrant | embedding | app) "$1" ;;
  *)
    sed -n '2,8p' "$SELF" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
