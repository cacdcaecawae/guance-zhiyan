#!/usr/bin/env bash
# deploy/guance.sh 冒烟测试（Linux / WSL，CI 中运行）：用替身代替 Qdrant 与向量服务，网站用真实入口（需先 pnpm build）。
# 覆盖：启动与健康检查、Qdrant 只监听本机且相对路径按仓库根目录解析、健康检查不在进程参数里暴露密钥、
# 进程退出后自动重启、重复启动被拒、deploy/.env 写了应用配置时拒绝启动、守护进程异常结束（含各服务都在重启等待中）
# 后的清理、停止时等整个进程组退出（组长先退、子进程不理会 TERM）、进程号被别的程序复用时不误杀、
# 以及在 git 仓库中时 update 的失败与成功路径。
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
if [ -f deploy/.env ]; then
  echo "deploy/.env 存在（已部署的仓库），不在这里运行测试。" >&2
  exit 1
fi
T=$(mktemp -d)
G=deploy/guance.sh
# 应用配置经环境变量传入（优先于 server/.env，网站与 status 一致）；Qdrant 路径故意写成相对仓库根目录的形式
export LOG_DIR=$T/logs DATA_DIR=$T/data PORT=33411 QDRANT_URL=http://127.0.0.1:33433 \
  EMBEDDING_URL=http://127.0.0.1:33481/embeddings EMBEDDING_MODEL=fake EMBEDDING_DIMENSIONS=2 \
  EMBEDDING_API_KEY=secret-test-key-1234 APP_MODE=local \
  QDRANT_STORAGE=$(realpath --relative-to=. "$T/qdrant") QDRANT_BIN=$(realpath --relative-to=. "$T/qdrant-bin")
cat >"$T/fake.py" <<'EOF'
# 替身：Qdrant（记下收到的配置）或向量服务（返回固定向量，响应前停 2 秒，便于检查进程参数；忽略 SIGTERM）
import json, os, signal, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
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
        self.send_response(200); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self.reply(b"ok")
    def do_POST(self):
        time.sleep(2)
        self.reply(json.dumps({"data": [{"index": 0, "embedding": [1, 0]}]}).encode())
    def log_message(self, *a):
        pass
HTTPServer((host, port), H).serve_forever()
EOF
printf '#!/bin/sh\nexec python3 %s qdrant\n' "$T/fake.py" >"$T/qdrant-bin"
chmod +x "$T/qdrant-bin"
# 两条命令：bash 不能直接 exec，python 成为 bash 的子进程且不理会 TERM，验证停止时等整个进程组退出
export EMBED_CMD="python3 $T/fake.py embedding 33481; true"
leftovers() { pgrep -f "$T/fake.py|server/index.ts --local" | wc -l; }
healthy() { [ "$(grep -cE '^(网站|Qdrant|向量服务)：正常$' <<<"$1")" = 3 ]; }
fail() {
  echo "失败：$*" >&2
  tail -n 20 "$LOG_DIR"/*.log >&2 || true
  bash $G stop >/dev/null || true
  exit 1
}
start() {
  setsid bash $G run >>"$T/run.out" 2>&1 </dev/null &
  disown
  local status=
  for _ in $(seq 60); do
    status=$(bash $G status) || true
    healthy "$status" && return 0
    sleep 2
  done
  echo "$status"
  fail "60 秒内网站、Qdrant、向量服务未全部正常"
}
clean_after_stop() {
  sleep 6 # 超过重启间隔：若有守护子 shell 遗留，会把服务重新拉起
  [ "$(leftovers)" = 0 ] || fail "$1：仍有进程 $(pgrep -af "$T/fake.py|server/index.ts --local")"
}

echo "== 应用配置写在 deploy/.env 时拒绝启动"
echo "DATA_DIR=/elsewhere" >deploy/.env
out=$(bash $G run 2>&1) && fail "deploy/.env 含应用配置时仍启动"
rm deploy/.env
grep -q 'DATA_DIR 移到 server/.env' <<<"$out" || fail "未提示把 DATA_DIR 移到 server/.env：$out"

echo "== 启动与健康检查"
start
grep -q "\"QDRANT__SERVICE__HOST\": \"127.0.0.1\"" "$T/qdrant/env.json" || fail "Qdrant 未限定监听本机"
grep -q "\"QDRANT__SERVICE__HTTP_PORT\": \"33433\"" "$T/qdrant/env.json" || fail "Qdrant 端口未取自 QDRANT_URL"
grep -q "\"cwd\": \"$T/qdrant\"" "$T/qdrant/env.json" || fail "Qdrant 相对路径未按仓库根目录解析"
grep -q '已在运行' <<<"$(bash $G run)" || fail "重复启动未被拒绝"

echo "== 健康检查期间密钥不出现在任何进程的参数里"
bash $G status >/dev/null &
checker=$!
sleep 1
# 匹配串从文件读取，避免 grep 自己的参数里出现密钥
echo "$EMBEDDING_API_KEY" >"$T/secret"
exposed=$(grep -lFf "$T/secret" /proc/[0-9]*/cmdline 2>/dev/null || true)
[ -z "$exposed" ] || fail "密钥出现在进程参数中：$(for f in $exposed; do tr '\0' ' ' <"$f"; echo; done)"

wait $checker || true

echo "== 网站被强制结束后自动重启"
old=$(cat "$LOG_DIR/app.pid")
kill -9 "$old"
for _ in $(seq 60); do
  new=$(cat "$LOG_DIR/app.pid" 2>/dev/null) || true
  [ "$new" != "$old" ] && curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  sleep 2
done
[ "$new" != "$old" ] || fail "网站退出后未重启"

echo "== 守护进程在各服务都处于重启等待时被强制结束"
for name in qdrant embedding app; do kill -KILL -- "-$(cat "$LOG_DIR/$name.pid")"; done
sleep 1
kill -9 "$(cat "$LOG_DIR/run.pid")"
grep -q '先执行 deploy/guance.sh stop' <<<"$(bash $G run)" || fail "守护进程异常结束后未拒绝重新启动"
grep -q '遗留进程' <<<"$(bash $G status)" || fail "status 未提示遗留进程"
bash $G stop | grep -q '已停止' || fail "stop 未完成清理"
clean_after_stop "清理遗留的守护子 shell 后"

echo "== 正常停止：等向量服务进程组整体退出（组长先退，子进程不理会 TERM）"
start
stopped=$(bash $G stop) || fail "stop 返回失败：$stopped"
[ "$stopped" = "已停止。" ] || fail "stop 输出异常：$stopped"
clean_after_stop "正常停止后"
[ -z "$(ls "$LOG_DIR"/*.pid 2>/dev/null)" ] || fail "停止后仍有进程号文件"

echo "== 进程号被别的程序复用时，stop 不误杀"
setsid sleep 120 &
stranger=$!
echo "$stranger" >"$LOG_DIR/app.pid"
grep -q '未在运行' <<<"$(bash $G stop)" || fail "把无关进程当成了本服务"
kill -0 "$stranger" 2>/dev/null || fail "无关进程被结束"
kill "$stranger"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -z "$(git status --porcelain --untracked-files=no)" ]; then
  echo "== update：构建失败时不动正在使用的代码；成功时切换并重启网站"
  start
  before=$(git rev-parse HEAD)
  old=$(cat "$LOG_DIR/app.pid")
  if bash $G update no-such-ref; then fail "不存在的版本却更新成功"; fi
  [ "$(git rev-parse HEAD)" = "$before" ] && [ "$(cat "$LOG_DIR/app.pid")" = "$old" ] ||
    fail "更新失败后代码或网站被改动"
  bash $G update HEAD || fail "更新到当前版本失败"
  for _ in $(seq 60); do
    new=$(cat "$LOG_DIR/app.pid" 2>/dev/null) || true
    [ "$new" != "$old" ] && curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break
    sleep 2
  done
  [ "$new" != "$old" ] || fail "更新后网站未重启"
  [ ! -e deploy/.update ] || fail "更新后临时工作树未清理"
  bash $G stop >/dev/null
  clean_after_stop "更新测试后"
else
  echo "== 跳过 update 测试（不在 git 工作区，或工作区有改动）"
fi
rm -rf "$T"
echo "deploy/guance.sh 冒烟测试通过"
