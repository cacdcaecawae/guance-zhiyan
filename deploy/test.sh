#!/usr/bin/env bash
# deploy/guance.sh 冒烟测试（Linux / WSL，CI 中运行；需先 pnpm build）。Qdrant 与向量服务用替身，网站用真实入口。
# 总是测：生成的 systemd 单元通过 systemd-analyze verify；deploy/.env 写了应用配置、有语法错误或 APP_MODE 无效时 install
# 拒绝、服务入口以 78 退出；直接运行各服务入口时的健康检查（向量服务按配置的维度检查、经出站代理才能访问时也正常）；
# Qdrant 只监听本机且相对路径按仓库根目录解析；健康检查不在进程参数里暴露密钥；server/.env 的行尾注释、export 与空格写法
# 按 Node 的规则读取。有 systemd 与免密 sudo、且本机没有已装的 guance-* 服务和 server/.env 时（如 CI），再真实安装：
# Qdrant 起不来时 install 报失败；开机自启、加固选项生效且数据目录可写、崩溃后自动重启、停止后不留进程。
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
if [ -f deploy/.env ]; then
  echo "deploy/.env 存在（已部署的仓库），不在这里运行测试。" >&2
  exit 1
fi
# 不放在 /tmp：单元带 PrivateTmp=yes，服务看到的是自己的 /tmp
mkdir -p "$HOME/.cache"
T=$(mktemp -d "$HOME/.cache/guance-smoke.XXXXXX")
G=deploy/guance.sh
UNITS=(guance-qdrant guance-embedding guance-app)
# 应用配置经环境变量传入（优先于 server/.env，网站与 status 一致）；Qdrant 路径故意写成相对仓库根目录的形式
export DATA_DIR=$T/data PORT=33411 QDRANT_URL=http://127.0.0.1:33433 \
  EMBEDDING_URL=http://127.0.0.1:33481/embeddings EMBEDDING_MODEL=fake EMBEDDING_DIMENSIONS=2 \
  EMBEDDING_API_KEY=secret-test-key-1234 APP_MODE=local \
  QDRANT_STORAGE=$(realpath --relative-to=. "$T/qdrant") QDRANT_BIN=$(realpath --relative-to=. "$T/qdrant-bin")
cat >"$T/fake.py" <<'EOF'
# 替身：Qdrant（记下收到的配置）或向量服务（返回固定 2 维向量，响应前停 2 秒，便于检查进程参数；忽略 SIGTERM；
# 兼作 HTTP 代理：CONNECT 隧道一律接到自己，用于“只能经代理访问”的向量服务）
import json, os, select, signal, socket, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
kind = sys.argv[1]
if kind == "qdrant":
    json.dump({k: v for k, v in os.environ.items() if k.startswith("QDRANT__")} | {"cwd": os.getcwd()},
              open(os.environ["QDRANT__STORAGE__STORAGE_PATH"] + "/env.json", "w"))
    host, port = os.environ["QDRANT__SERVICE__HOST"], int(os.environ["QDRANT__SERVICE__HTTP_PORT"])
else:
    host, port = "127.0.0.1", int(sys.argv[2])
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
class H(BaseHTTPRequestHandler):
    def reply(self, body):
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self.reply(b"ok")
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        time.sleep(2)
        self.reply(json.dumps({"data": [{"index": 0, "embedding": [1, 0]}]}).encode())
    def do_CONNECT(self):
        up = socket.create_connection(("127.0.0.1", port))
        self.send_response(200); self.end_headers()
        ends = [self.connection, up]
        while True:
            ready, _, _ = select.select(ends, [], [], 30)
            if not ready: return
            for end in ready:
                data = end.recv(65536)
                if not data: return
                (up if end is self.connection else self.connection).sendall(data)
    def log_message(self, *a):
        pass
ThreadingHTTPServer((host, port), H).serve_forever()
EOF
printf '#!/bin/sh\nexec python3 %s qdrant\n' "$T/fake.py" >"$T/qdrant-bin"
chmod +x "$T/qdrant-bin"
# 两条命令：bash 不能直接 exec，python 成为 bash 的子进程且不理会 TERM，验证停止时结束整个控制组
export EMBED_CMD="python3 $T/fake.py embedding 33481; true"
installed=
leftovers() { pgrep -f "$T/fake.py|server/index.ts --local" | wc -l; }
healthy() { [ "$(grep -cE '^(网站|Qdrant|向量服务)：正常$' <<<"$1")" = 3 ]; }
stop_direct() {
  local pid
  for pid in $(cat "$T/direct.pids" 2>/dev/null); do kill -KILL -- "-$pid" 2>/dev/null || true; done
  rm -f "$T/direct.pids"
}
cleanup() {
  stop_direct
  if [ -n "$installed" ]; then
    sudo systemctl disable --now "${UNITS[@]}" >/dev/null 2>&1 || true
    for unit in "${UNITS[@]}"; do sudo rm -f "/etc/systemd/system/$unit.service"; done
    sudo systemctl daemon-reload
  fi
  # 开始时已确认 deploy/.env 不存在；server/.env 只删本测试建的
  rm -f deploy/.env
  [ ! -e "$T/server-env" ] || rm -f server/.env
  rm -rf "$T"
}
trap cleanup EXIT
fail() {
  echo "失败：$*" >&2
  tail -n 20 "$T"/*.log >&2 2>/dev/null || true
  [ -z "$installed" ] || sudo -n journalctl -n 40 --no-pager "${UNITS[@]/#/-u}" >&2 || true
  exit 1
}
wait_healthy() {
  local status=
  for _ in $(seq 60); do
    status=$(bash $G status 2>&1) || true
    healthy "$status" && return 0
    sleep 2
  done
  echo "$status"
  fail "$1：60 秒内网站、Qdrant、向量服务未全部正常"
}
# 直接运行三个服务入口（不经 systemd），各自成一个进程组以便结束
start_direct() {
  local name
  for name in qdrant embedding app; do
    setsid bash $G $name >>"$T/$name.log" 2>&1 </dev/null &
    echo $! >>"$T/direct.pids"
    disown
  done
  wait_healthy "直接运行服务入口"
}
# deploy/.env 为第一个参数时 install 应拒绝并给出第二个参数中的提示，服务入口以 78 退出（timeout 只防测试卡住）
refused() {
  printf '%s\n' "$1" >deploy/.env
  local out code=0
  out=$(timeout 60 bash $G install 2>&1) && fail "deploy/.env 为 $1 时 install 仍执行"
  grep -q "$2" <<<"$out" || fail "deploy/.env 为 $1 时未提示 $2：$out"
  timeout 60 bash $G app >/dev/null 2>&1 || code=$?
  [ "$code" = 78 ] || fail "deploy/.env 为 $1 时网站入口退出码为 $code（应为 78）"
  rm deploy/.env
}

echo "== deploy/.env 写了应用配置、有语法错误或 APP_MODE 无效时拒绝"
refused DATA_DIR=/elsewhere 'DATA_DIR 移到 server/.env'
refused 'EMBED_CMD="unterminated' 'deploy/.env 读取失败'
refused APP_MODE=locla 'APP_MODE 只能是 local 或 server'

echo "== 生成的 systemd 单元"
bash $G units "$T/units"
[ "$(ls "$T/units")" = "$(printf '%s.service\n' guance-app guance-embedding guance-qdrant)" ] ||
  fail "单元不全：$(ls "$T/units")"
for unit in "$T"/units/*.service; do
  for line in Restart=always RestartSec=5 RestartPreventExitStatus=78 NoNewPrivileges=yes PrivateTmp=yes \
    ProtectSystem=full UMask=0077 "ExecStart=$PWD/deploy/guance.sh"; do
    grep -q "^$line" "$unit" || fail "$(basename "$unit") 缺少 $line"
  done
done
grep -qx 'Wants=guance-qdrant.service guance-embedding.service' "$T/units/guance-app.service" ||
  fail "网站未依赖 Qdrant 与向量服务"
if command -v systemd-analyze >/dev/null; then
  systemd-analyze verify "$T"/units/*.service || fail "systemd-analyze verify 未通过"
else
  echo "（没有 systemd-analyze，跳过 verify）"
fi

echo "== 直接运行服务入口：健康检查"
start_direct
grep -q "\"QDRANT__SERVICE__HOST\": \"127.0.0.1\"" "$T/qdrant/env.json" || fail "Qdrant 未限定监听本机"
grep -q "\"QDRANT__SERVICE__HTTP_PORT\": \"33433\"" "$T/qdrant/env.json" || fail "Qdrant 端口未取自 QDRANT_URL"
grep -q "\"cwd\": \"$T/qdrant\"" "$T/qdrant/env.json" || fail "Qdrant 相对路径未按仓库根目录解析"
# 替身固定返回 2 维；配置成 3 维时网站的请求会失败，健康检查也必须报错
# 先取输出再匹配：直接接管道时 grep -q 提前退出，status 收到 SIGPIPE，pipefail 下整条管道失败、fail 不会执行
out=$(EMBEDDING_DIMENSIONS=3 bash $G status)
grep -q '^向量服务：正常$' <<<"$out" && fail "维度与向量服务不符时仍报告正常"
# 向量服务的主机名只有代理能解析：网站经 configureNetwork 走代理能取到向量，健康检查也必须走同一代理
out=$(HTTP_PROXY=http://127.0.0.1:33481 NO_PROXY=127.0.0.1,localhost \
  EMBEDDING_URL=http://guance-embed.invalid:33481/embeddings bash $G status)
grep -q '^向量服务：正常$' <<<"$out" || fail "只能经代理访问的向量服务被报告为无响应：$out"

echo "== 健康检查期间密钥不出现在任何进程的参数里"
bash $G status >/dev/null &
checker=$!
sleep 1
# 匹配串从文件读取，避免 grep 自己的参数里出现密钥
echo "$EMBEDDING_API_KEY" >"$T/secret"
exposed=$(grep -lFf "$T/secret" /proc/[0-9]*/cmdline 2>/dev/null || true)
[ -z "$exposed" ] || fail "密钥出现在进程参数中：$(for f in $exposed; do tr '\0' ' ' <"$f"; echo; done)"
wait $checker || true
stop_direct
sleep 1
[ "$(leftovers)" = 0 ] || fail "结束直接运行的服务后仍有进程"

if [ -e server/.env ]; then
  echo "== 跳过 server/.env 写法测试（已有 server/.env）"
else
  echo "== server/.env 的行尾注释、export 与等号两侧空格按 Node 的规则读取"
  : >"$T/server-env"
  printf '%s\n' "QDRANT_URL=$QDRANT_URL # local vector store" "export PORT=$PORT" \
    "EMBEDDING_MODEL = $EMBEDDING_MODEL" >server/.env
  saved=("QDRANT_URL=$QDRANT_URL" "PORT=$PORT" "EMBEDDING_MODEL=$EMBEDDING_MODEL")
  unset QDRANT_URL PORT EMBEDDING_MODEL
  rm -f "$T/qdrant/env.json"
  start_direct
  grep -q "\"QDRANT__SERVICE__HTTP_PORT\": \"33433\"" "$T/qdrant/env.json" || fail "Qdrant 端口与网站读到的 QDRANT_URL 不一致"
  stop_direct
  rm server/.env "$T/server-env"
  export "${saved[@]}"
fi

if ! { [ -d /run/systemd/system ] && sudo -n true 2>/dev/null; }; then
  echo "== 跳过 systemd 安装测试（需要运行中的 systemd 与免密 sudo）"
elif [ -e server/.env ] || ls /etc/systemd/system/guance-*.service >/dev/null 2>&1; then
  echo "== 跳过 systemd 安装测试（本机已有 server/.env 或已装的 guance-* 服务）"
else
  echo "== systemd：Qdrant 起不来时 install 报失败；正常安装后开机自启、加固选项生效、数据目录可写"
  # 服务不继承本 shell 的环境：应用配置写进 server/.env，进程配置写进 deploy/.env（node 不在 systemd 的默认 PATH 时补上）
  : >"$T/server-env"
  printf '%s\n' "DATA_DIR=$T/sdata" "PORT=$PORT" "QDRANT_URL=$QDRANT_URL" "EMBEDDING_URL=$EMBEDDING_URL" \
    "EMBEDDING_MODEL=fake" "EMBEDDING_DIMENSIONS=2" "EMBEDDING_API_KEY=$EMBEDDING_API_KEY" >server/.env
  # PATH 在原值前追加：服务里原值是 systemd 的默认 PATH，直接运行脚本时是本 shell 的
  printf '%s\n' "PATH=$(dirname "$(command -v node)"):\$PATH" "QDRANT_BIN=$QDRANT_BIN" \
    "QDRANT_STORAGE=$QDRANT_STORAGE" "EMBED_CMD=\"$EMBED_CMD\"" APP_MODE=local >deploy/.env
  unset DATA_DIR PORT QDRANT_URL EMBEDDING_URL EMBEDDING_MODEL EMBEDDING_DIMENSIONS EMBEDDING_API_KEY APP_MODE \
    QDRANT_BIN QDRANT_STORAGE EMBED_CMD
  rm -f "$T/qdrant/env.json"
  installed=1
  # 先装一个起不来的 Qdrant（启动即退出、反复重启）：网站照常健康，install 也必须报失败并指出 Qdrant
  cp deploy/.env "$T/deploy-env"
  sed -i 's#^QDRANT_BIN=.*#QDRANT_BIN=/bin/false#' deploy/.env
  out=$(timeout 300 bash $G install 2>&1) && fail "Qdrant 起不来时 install 仍报告成功：$out"
  grep -q 'guance-qdrant' <<<"$out" || fail "install 失败时未指出 guance-qdrant：$out"
  cp "$T/deploy-env" deploy/.env
  out=$(bash $G install) || fail "install 失败：$out"
  grep -q '已安装并启动' <<<"$out" || fail "install 未报告启动：$out"
  for unit in "${UNITS[@]}"; do
    [ "$(systemctl is-enabled "$unit")" = enabled ] || fail "$unit 未设为开机自启"
    hardening=$(systemctl show -p NoNewPrivileges,PrivateTmp,ProtectSystem,UMask "$unit" | sort | paste -sd ' ')
    [ "$hardening" = "NoNewPrivileges=yes PrivateTmp=yes ProtectSystem=full UMask=0077" ] ||
      fail "$unit 的加固选项未生效：$hardening"
  done
  wait_healthy "安装后"
  out=$(bash $G status)
  [ "$(grep -c '^guance-[a-z]*：active$' <<<"$out")" = 3 ] || fail "status 未显示三个服务运行中：$out"
  [ -e "$T/sdata/app.sqlite" ] || fail "网站未能写入数据目录"
  [ "$(stat -c %a "$T/qdrant/env.json")" = 600 ] || fail "Qdrant 未能写入数据目录，或 UMask 未生效"
  [ "$(stat -c %U "$T/qdrant/env.json")" = "$(id -un)" ] || fail "服务未以安装账号运行"

  echo "== systemd：网站被强制结束后自动重启"
  old=$(systemctl show -p MainPID --value guance-app)
  kill -9 "$old"
  for _ in $(seq 30); do
    new=$(systemctl show -p MainPID --value guance-app)
    [ "$new" != 0 ] && [ "$new" != "$old" ] && curl -fs "http://127.0.0.1:33411/api/health" >/dev/null && break
    sleep 1
  done
  [ "$new" != 0 ] && [ "$new" != "$old" ] || fail "网站退出后未重启"

  echo "== systemd：停止后不留进程（向量服务的子进程不理会 TERM）"
  sudo systemctl stop "${UNITS[@]}"
  [ "$(leftovers)" = 0 ] || fail "停止后仍有进程：$(pgrep -af "$T/fake.py|server/index.ts --local")"
fi
echo "deploy/guance.sh 冒烟测试通过"
