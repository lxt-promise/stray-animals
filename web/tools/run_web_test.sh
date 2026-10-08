#!/bin/bash
# 拉起识别服务 → 等就绪 → 跑 Web 链路验收 → 收掉
export PATH="/usr/bin:/bin:/mingw64/bin:$PATH"
R="E:/Agent/project/stray-animals"
PY="$R/env/Scripts/python.exe"

# 探测必须校验响应体，光看 curl 退出码会把「连接被拒」误判为已在运行
healthy() {
  local body
  body=$(curl -s -m 3 "$1" 2>/dev/null)
  [ -n "$body" ] && [ "${body:0:1}" = "{" ]
}

# 若已在跑就不重复启动
if healthy http://127.0.0.1:8090/health; then
  echo "[识别服务] 已在运行"
  OWN=0
else
  cd "$R/server" || exit 1
  "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port 8090 > "$R/_vision.log" 2>&1 &
  VPID=$!
  OWN=1
  echo "[识别服务] 启动中 pid=$VPID"
  for i in $(seq 1 40); do
    if healthy http://127.0.0.1:8090/health; then break; fi
    sleep 2
  done
fi

echo "[识别服务] $(curl -s -m 5 http://127.0.0.1:8090/health)"
echo "[后端]     $(curl -s -m 5 http://127.0.0.1:8080/api/vision/health)"
echo

cd "$R/web" || exit 1
"$PY" -u tools/web_vision_test.py
RC=$?

if [ "$OWN" = "1" ] && [ -n "$VPID" ]; then
  kill "$VPID" 2>/dev/null
  echo "[识别服务] 已停止 pid=$VPID"
fi
exit $RC
