@echo off
REM 喵园识别服务 —— Windows 本地一键启动
REM 前提：已用 tools\fetch_model.py 下载好模型到 server\models\

setlocal
cd /d "%~dp0.."

set PY=E:\Agent\project\stray-animals\env\Scripts\python.exe
if not exist "%PY%" (
    echo [错误] 未找到虚拟环境：%PY%
    echo 请先执行：python -m venv env ^&^& env\Scripts\python -m pip install -r requirements.txt
    exit /b 1
)

echo [1/2] 检查模型...
if not exist "models\reid.onnx" (
    echo 未找到 models\reid.onnx，将使用占位引擎启动（识别结果为演示级）
) else (
    echo 骨干权重已就绪
)

echo [2/2] 启动服务 http://127.0.0.1:8090
echo 健康检查： http://127.0.0.1:8090/health
"%PY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8090
