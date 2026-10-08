#!/bin/bash
# 全链路页面验证：拉起识别服务(8090) → 跑页面渲染检查 → 收掉
# 后端(8080)与前端(5173)需已在运行。
export PATH="/usr/bin:/bin:/mingw64/bin:$PATH"
R="E:/Agent/project/stray-animals"
PY="$R/env/Scripts/python.exe"
NODE="E:/Agent/WorkBuddy/binaries/node/versions/22.22.2-3/node.exe"

healthy() {
  local body
  body=$(curl -s -m 3 "$1" 2>/dev/null)
  [ -n "$body" ] && [ "${body:0:1}" = "{" ]
}

if healthy http://127.0.0.1:8090/health; then
  echo "[识别服务] 已在运行"; OWN=0
else
  cd "$R/server" || exit 1
  "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port 8090 > "$R/_vision.log" 2>&1 &
  VPID=$!; OWN=1
  echo "[识别服务] 启动中 pid=$VPID"
  for i in $(seq 1 40); do healthy http://127.0.0.1:8090/health && break; sleep 2; done
fi
echo "[识别服务] $(curl -s -m 5 http://127.0.0.1:8090/health)"
echo "[后端]     $(curl -s -m 5 http://127.0.0.1:8080/api/vision/health)"

# Vite 默认只绑 [::1]，localhost 才通
FRONT="${FRONT:-http://localhost:5173/vision}"
echo "[前端]     $FRONT"
echo

cd "$R/web" || exit 1
URL="$FRONT" "$NODE" tools/vision_page_check.cjs
RC=$?

if [ "$OWN" = "1" ] && [ -n "$VPID" ]; then
  kill "$VPID" 2>/dev/null
  echo "[识别服务] 已停止 pid=$VPID"
fi
exit $RC
