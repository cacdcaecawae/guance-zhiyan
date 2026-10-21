#!/usr/bin/env bash
# deploy/guance.sh 冒烟测试（Linux / WSL，CI 中运行）：用替身代替 Qdrant 与向量服务，网站用真实入口（需先 pnpm build）。
# 覆盖：deploy/.env 写了应用配置、有语法错误或 APP_MODE 无效时拒绝启动，而 status、stop 照常可用；启动与健康检查
# （向量服务按配置的维度检查）；Qdrant 只监听本机且相对路径按仓库根目录解析；健康检查不在进程参数里暴露密钥；
# server/.env 的行尾注释、export 与空格写法按 Node 的规则读取；进程退出后自动重启、重复启动被拒；守护进程异常结束
# （含各服务都在重启等待中）后的清理；停止时等整个进程组退出（组长先退、子进程不理会 TERM）；进程号被别的程序复用时
# 不误杀；以及在 git 仓库中时 update 的构建失败、切换依赖期间网站退出、替换页面失败与成功路径。
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
ROOT=$PWD
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
  # 开始时已确认 deploy/.env 不存在；server/.env 只删本测试建的
  rm -f deploy/.env "$LOG_DIR/app.hold"
  [ ! -e "$T/server-env" ] || rm -f server/.env
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
wait_app() {
  for _ in $(seq 60); do
    curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && return 0
    sleep 2
  done
  fail "$1"
}
clean_after_stop() {
  sleep 6 # 超过重启间隔：若有守护子 shell 遗留，会把服务重新拉起
  [ "$(leftovers)" = 0 ] || fail "$1：仍有进程 $(pgrep -af "$T/fake.py|server/index.ts --local")"
}
# deploy/.env 为第一个参数时 run 应立即退出、不启动任何服务，并给出第二个参数中的提示（timeout 只防测试卡住）
refused() {
  printf '%s\n' "$1" >deploy/.env
  local out
  out=$(timeout 60 bash $G run 2>&1) && fail "deploy/.env 为 $1 时仍启动"
  rm deploy/.env
  grep -q "$2" <<<"$out" || fail "deploy/.env 为 $1 时未提示 $2：$out"
  [ -z "$(ls "$LOG_DIR"/*.pid 2>/dev/null)" ] || fail "deploy/.env 为 $1 时仍启动了服务"
}

echo "== deploy/.env 写了应用配置、有语法错误或 APP_MODE 无效时拒绝启动"
refused DATA_DIR=/elsewhere 'DATA_DIR 移到 server/.env'
refused 'EMBED_CMD="unterminated' 'deploy/.env 读取失败'
refused APP_MODE=locla 'APP_MODE 只能是 local 或 server'

echo "== 启动与健康检查"
start
grep -q "\"QDRANT__SERVICE__HOST\": \"127.0.0.1\"" "$T/qdrant/env.json" || fail "Qdrant 未限定监听本机"
grep -q "\"QDRANT__SERVICE__HTTP_PORT\": \"33433\"" "$T/qdrant/env.json" || fail "Qdrant 端口未取自 QDRANT_URL"
grep -q "\"cwd\": \"$T/qdrant\"" "$T/qdrant/env.json" || fail "Qdrant 相对路径未按仓库根目录解析"
grep -q '已在运行' <<<"$(bash $G run)" || fail "重复启动未被拒绝"
# 替身固定返回 2 维；配置成 3 维时网站的请求会失败，健康检查也必须报错
# 先取输出再匹配：直接接管道时 grep -q 提前退出，status 收到 SIGPIPE，pipefail 下整条管道失败、fail 不会执行
out=$(EMBEDDING_DIMENSIONS=3 bash $G status)
grep -q '^向量服务：正常$' <<<"$out" && fail "维度与向量服务不符时仍报告正常"

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

echo "== 正常停止，deploy/.env 写错时也能查看和停止：等向量服务进程组整体退出（组长先退，子进程不理会 TERM）"
start
echo "DATA_DIR=/elsewhere" >deploy/.env
grep -q '^守护进程：运行中' <<<"$(bash $G status 2>/dev/null)" || fail "deploy/.env 写错后 status 不可用"
stopped=$(bash $G stop 2>/dev/null) || fail "deploy/.env 写错后 stop 失败：$stopped"
rm deploy/.env
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
  start
  grep -q "\"QDRANT__SERVICE__HTTP_PORT\": \"33433\"" "$T/qdrant/env.json" || fail "Qdrant 端口与网站读到的 QDRANT_URL 不一致"
  bash $G stop >/dev/null
  clean_after_stop "server/.env 写法测试后"
  rm server/.env "$T/server-env"
  export "${saved[@]}"
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -z "$(git status --porcelain --untracked-files=no)" ]; then
  echo "== update：构建失败时不动正在使用的代码"
  start
  before=$(git rev-parse HEAD)
  old=$(cat "$LOG_DIR/app.pid")
  if bash $G update no-such-ref; then fail "不存在的版本却更新成功"; fi
  [ "$(git rev-parse HEAD)" = "$before" ] && [ "$(cat "$LOG_DIR/app.pid")" = "$old" ] ||
    fail "更新失败后代码或网站被改动"

  # 替身 pnpm 与 mv：只在下面几次 update 时放在 PATH 最前，有标记文件时注入一次故障
  mkdir "$T/inject"
  cat >"$T/inject/pnpm" <<EOF
#!/usr/bin/env bash
# 在正在使用的工作区里安装依赖时：网站恰好退出（模拟崩溃），停 7 秒（超过重启间隔），记下网站进程数后报失败
if [ "\$PWD" = "$ROOT" ] && [ "\$1" = install ] && [ -e "$T/fail-install" ]; then
  rm "$T/fail-install"
  kill -9 "\$(cat "$LOG_DIR/app.pid")" 2>/dev/null
  sleep 7
  pgrep -fc "server/index.ts --local" >"$T/apps-during-install" || true
  exit 1
fi
exec $(command -v pnpm) "\$@"
EOF
  cat >"$T/inject/mv" <<EOF
#!/usr/bin/env bash
# 把新页面移到 dist/ 的那一步失败一次
if [ -e "$T/fail-mv" ] && [[ "\$*" == *deploy/.update/dist* ]]; then
  rm "$T/fail-mv"
  exit 1
fi
exec $(command -v mv) "\$@"
EOF
  chmod +x "$T/inject/pnpm" "$T/inject/mv"

  echo "== update：切换依赖期间网站退出时不被重启，失败后退回并以原版本恢复"
  : >"$T/fail-install"
  if PATH=$T/inject:$PATH bash $G update HEAD; then fail "切换依赖失败却报告更新成功"; fi
  [ "$(cat "$T/apps-during-install" 2>/dev/null)" = 0 ] ||
    fail "切换依赖期间网站被重新启动（$(cat "$T/apps-during-install" 2>/dev/null || echo 未注入故障)）"
  [ "$(git rev-parse HEAD)" = "$before" ] || fail "切换失败后代码未退回"
  wait_app "切换失败退回后网站未恢复"

  echo "== update：替换页面失败时报告失败，放回原页面并退回代码"
  : >dist/.smoke-marker
  : >"$T/fail-mv"
  if PATH=$T/inject:$PATH bash $G update HEAD; then fail "替换页面失败却报告更新成功"; fi
  [ -e dist/.smoke-marker ] || fail "替换页面失败后原页面未放回"
  [ "$(git rev-parse HEAD)" = "$before" ] || fail "替换页面失败后代码未退回"
  wait_app "替换页面失败后网站未恢复"
  rm dist/.smoke-marker

  echo "== update：成功时切换并以新版本重启网站"
  old=$(cat "$LOG_DIR/app.pid")
  bash $G update HEAD || fail "更新到当前版本失败"
  for _ in $(seq 60); do
    new=$(cat "$LOG_DIR/app.pid" 2>/dev/null) || true
    [ "$new" != "$old" ] && curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break
    sleep 2
  done
  [ "$new" != "$old" ] || fail "更新后网站未重启"
  [ ! -e deploy/.update ] || fail "更新后临时工作树未清理"
  [ ! -e "$LOG_DIR/app.hold" ] || fail "更新后网站仍处于暂停"
  bash $G stop >/dev/null
  clean_after_stop "更新测试后"
else
  echo "== 跳过 update 测试（不在 git 工作区，或工作区有改动）"
fi
rm -rf "$T"
echo "deploy/guance.sh 冒烟测试通过"
