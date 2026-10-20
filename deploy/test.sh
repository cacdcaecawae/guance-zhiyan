#!/usr/bin/env bash
# deploy/guance.sh 冒烟测试（Linux / WSL，CI 中运行）：用替身代替 Qdrant 与向量服务，网站用真实入口（需先 pnpm build）。
# 验证启动与健康检查、Qdrant 只监听本机、进程退出后自动重启、重复启动被拒、守护进程异常结束后的清理，
# 以及停止后不留进程（含 shell 拉起的子进程）。
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
if [ -f deploy/.env ]; then
  echo "deploy/.env 存在（已部署的仓库），不在这里运行测试。" >&2
  exit 1
fi
T=$(mktemp -d)
G=deploy/guance.sh
export LOG_DIR=$T/logs DATA_DIR=$T/data PORT=33411 QDRANT_URL=http://127.0.0.1:33433 \
  EMBEDDING_URL=http://127.0.0.1:33481/embeddings EMBEDDING_MODEL=fake EMBEDDING_DIMENSIONS=2 \
  QDRANT_STORAGE=$T/qdrant QDRANT_BIN=$T/qdrant-bin APP_MODE=local
cat >"$T/fake.py" <<'EOF'
# 替身：Qdrant（记下收到的配置）或向量服务（返回固定向量）
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
kind, port = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 0
if kind == "qdrant":
    json.dump({k: v for k, v in os.environ.items() if k.startswith("QDRANT__")}, open(os.environ["QDRANT__STORAGE__STORAGE_PATH"] + "/env.json", "w"))
    host, port = os.environ["QDRANT__SERVICE__HOST"], int(os.environ["QDRANT__SERVICE__HTTP_PORT"])
else:
    host = "127.0.0.1"
class H(BaseHTTPRequestHandler):
    def reply(self, body):
        self.send_response(200); self.end_headers(); self.wfile.write(body)
    do_GET = lambda self: self.reply(b"ok")
    do_POST = lambda self: self.reply(json.dumps({"data": [{"index": 0, "embedding": [1, 0]}]}).encode())
    log_message = lambda *a: None
HTTPServer((host, port), H).serve_forever()
EOF
printf '#!/bin/sh\nexec python3 %s qdrant\n' "$T/fake.py" >"$T/qdrant-bin"
chmod +x "$T/qdrant-bin"
# 两条命令：bash 不能直接 exec，python 成为 bash 的子进程，用来验证停止时整组结束
export EMBED_CMD="python3 $T/fake.py embedding 33481; true"
leftovers() { pgrep -f "$T/fake.py|server/index.ts --local" | wc -l; }
healthy() { [ "$(grep -cE '^(网站|Qdrant|向量服务)：正常$' <<<"$1")" = 3 ]; }
fail() {
  echo "失败：$*" >&2
  tail -n 20 "$LOG_DIR"/*.log >&2 || true
  bash $G stop >/dev/null || true
  exit 1
}

setsid bash $G run >"$T/run.out" 2>&1 </dev/null & disown
for _ in $(seq 60); do
  status=$(bash $G status) || true
  healthy "$status" && break
  sleep 2
done
echo "$status"
healthy "$status" || fail "60 秒内网站、Qdrant、向量服务未全部正常"
grep -q '"QDRANT__SERVICE__HOST": "127.0.0.1"' "$T/qdrant/env.json" || fail "Qdrant 未限定监听本机"
grep -q '"QDRANT__SERVICE__HTTP_PORT": "33433"' "$T/qdrant/env.json" || fail "Qdrant 端口未取自 QDRANT_URL"
grep -q '已在运行' <<<"$(bash $G run)" || fail "重复启动未被拒绝"

old=$(cat "$LOG_DIR/app.pid")
kill -9 "$old"
for _ in $(seq 60); do
  new=$(cat "$LOG_DIR/app.pid" 2>/dev/null) || true
  [ "$new" != "$old" ] && curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  sleep 2
done
[ "$new" != "$old" ] || fail "网站退出后未重启"

# 守护进程被强制结束：重新启动应拒绝并提示先 stop，stop 清理遗留的守护子进程与服务进程
kill -9 "$(cat "$LOG_DIR/run.pid")"
sleep 1
grep -q '先执行 deploy/guance.sh stop' <<<"$(bash $G run)" || fail "守护进程异常结束后未拒绝重新启动"
grep -q '遗留' <<<"$(bash $G stop)" || fail "stop 未清理遗留进程"
sleep 6 # 超过重启间隔：遗留的守护子进程若还在，会把服务重新拉起
[ "$(leftovers)" = 0 ] || fail "清理后仍有进程：$(pgrep -af "$T/fake.py|server/index.ts --local")"
setsid bash $G run >"$T/run2.out" 2>&1 </dev/null & disown
for _ in $(seq 60); do
  healthy "$(bash $G status)" && break
  sleep 2
done
healthy "$(bash $G status)" || fail "清理后未能重新启动"

bash $G stop
sleep 1
[ "$(leftovers)" = 0 ] || fail "停止后仍有进程：$(pgrep -af "$T/fake.py|server/index.ts --local")"
rm -rf "$T"
echo "deploy/guance.sh 冒烟测试通过"
