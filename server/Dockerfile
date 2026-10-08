# CatCampus 识别服务 —— 云托管（CloudBase Run）就绪镜像
#
# 与本地 docker-compose 的差异：
#   1) 监听平台注入的 PORT 环境变量（云托管必须；本地未注入时默认 8000，兼容 compose）
#   2) 模型权重直接打包进镜像（/app/models/reid.onnx），不再依赖外部挂载卷
#   3) 特征库固定落在 /data/catcampus，云托管把「持久卷」挂到这里即可跨重启保留
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

# ffmpeg 是视频抽帧的前提；libgl 供可能的 OpenCV 使用
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libgl1 libglib2.0-0 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir onnxruntime==1.19.2

# 代码 + 模型权重（.dockerignore 已排除本地缓存/数据/.env，但保留 models/）
COPY . .

# 特征库持久化挂载点：云托管把数据卷挂到 /data 即可
RUN mkdir -p /data/catcampus

# ---- 容器内固定配置（不依赖外部注入，保证模型一定被加载）----
ENV REID_ONNX=/app/models/reid.onnx \
    REID_SIZE=518 \
    INDEX_DB=/data/catcampus/index.sqlite3 \
    FETCH_TIMEOUT=20 \
    MAX_FRAMES=8

# ---- 端口 ----
# 云托管注入 PORT（通常 80）。uvicorn 不能自己展开 shell 变量，用 sh -c 包一层。
# 本地 docker / compose 不注入 PORT 时回退 8000，行为与旧版一致。
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
