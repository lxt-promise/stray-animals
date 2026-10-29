# 喵园 CatCampus · 识别服务（server/）本地开发指南

> 面向**接手识别服务的开发者**（第三方）。本文讲清：你改的是什么、本地怎么跑起来、怎么测、改完怎么发。
> 配套文档：《总使用手册》《自建识别服务方案》《识别服务接口文档》（均在 `docs/` 下）。

---

## 0. 你接手的是什么

`server/` 是**猫脸个体识别服务**（FastAPI + ONNX 推理），负责：检测猫 → 提特征 → 与特征库比对 → 返回候选猫 + 花色/品种判定。

它在整个产品里的位置：

```
微信小程序(miniprogram) ──▶ 云函数(cloudfunctions/catcampus) ──▶ 识别服务(server/)  ← 你改这里
                                                                      │
```

**重要解耦事实**：
- `server/` 是**独立服务**，可独立启动 / 测试 / 打包 / 部署，**不依赖小程序也不依赖 web**。

- 识别接口只暴露 `/v1/*`（见《识别服务接口文档》），鉴权靠 `API_TOKEN` 请求头。

---

## 1. 本地环境准备

### 1.1 Python 虚拟环境（已就绪）
项目自带 venv，路径：`E:\Agent\project\stray-animals\env`（Windows）。脚本全用这个解释器：

```bat
REM 所有 python 命令都用它，不要直接用系统 python
E:\Agent\project\stray-animals\env\Scripts\python.exe <xxx>.py
```

若环境被破坏需重建：
```bat
cd E:\Agent\project\stray-animals
python -m venv env
env\Scripts\python -m pip install -r server/requirements.txt
```
（依赖见 `server/requirements.txt`。**本地测试用默认的 SQLite 特征库后端，不需要腾讯云 COS**——`cos-python-sdk-v5` 在本地完全不被调用；`requirements.txt` 为部署方便把它平铺列出，装上无害。只有部署到云托管并设 `INDEX_BACKEND=cos` 时才真正用到它，且需配 `COS_*` 密钥，见第 4 节。）

### 1.2 模型权重（已就绪）
位置 `server/models/`：
- `reid.onnx`（~90MB，DINOv2-base 量化版，个体识别主干）
- `yolov8n.onnx`（~13MB，猫检测）

如缺失，用断点续传下载：
```bat
cd E:\Agent\project\stray-animals\server
..\env\Scripts\python tools\fetch_model.py
```

### 1.3 配置（server/.env）
`server/.env` 已存在，包含 `API_TOKEN` 等。**本地开发保持默认即可**，主要环境变量见第 4 节。不要提交真实密钥到仓库。

### 1.4 系统依赖
视频识别抽帧依赖**系统 ffmpeg**（`config.FFMPEG` 默认找 `ffmpeg` 命令）。纯图片识别不需要。

---

## 2. 本地启动

```bat
cd E:\Agent\project\stray-animals\server
..\env\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8090
```
或直接双击 `server/start.bat`（它已写死上面的命令）。

启动后验证健康检查（确认引擎/特征库加载成功）：
```bat
curl http://127.0.0.1:8090/health
```
返回 JSON 含 `indexed`（特征库猫数量）、`provider`（应为 `onnx`）、`detector`（应为 `on`）。

> 端口说明：本地用 **8090**；云托管注入 `PORT`（通常 80），`Dockerfile` 里已用 `uvicorn ... --port ${PORT:-8000}` 处理。

---

## 3. 怎么本地测试（5 种，按场景选）

### 3.1 单元测试（改完某个模块逻辑后跑）
```bat
cd E:\Agent\project\stray-animals\server
..\env\Scripts\python -m unittest discover -s tests -p "test_*.py"
```
覆盖 engine / attrs / index_store / recocache / quality_gate / scoring 等，**168+ 项全绿**算通过。断言打在「业务意图」上，旧断言也可能是错的——发现反直觉的失败先读测试意图再动代码。

### 3.2 端到端验收（真模型 + 真猫照区分度）
需**先起服务（第 2 节）**，再另开终端：
```bat
cd E:\Agent\project\stray-animals\server
..\env\Scripts\python tools\real_test.py
```
校验「同猫高分、异猫低分、无关图接近 0 分」三条区分度。要求 `provider==onnx`（真模型），占位引擎会跳过。

### 3.3 针对性调试脚本（按需）
- `tools/diag_night_shot.py`：夜间/低光图诊断，输出质量门控（area / lightMeanV / reason）+ 花色判定，排查"夜间误判"用。
- `tools/attr_probe.py` / `tools/ab_eval.py` / `tools/mv_eval.py`：花色/属性/多视频评估。
- 快速计时（排查慢）：临时脚本 `from app.engine import get_engine; eng=eng.get_engine(); ...` 直接对 `eng.detector.detect` / `eng._embed` 计时。实测 detect≈70ms、embed≈135ms——**推理本身极快，瓶颈在下载/网络**。

### 3.4 语法快检（改完先过一遍，避免低级错误）
```bat
..\env\Scripts\python -c "import ast; ast.parse(open('app/main.py',encoding='utf-8').read()); print('main.py OK')"
```

### 3.5 接口手测
服务起来后，用 `curl` 或 `web/` 的 `/vision` 页（见第 5 节）直接打 `/v1/recognize`：
```bat
curl -X POST http://127.0.0.1:8090/v1/recognize ^
  -H "Authorization: Bearer <server/.env 里的 API_TOKEN>" ^
  -H "Content-Type: application/json" ^
  -d "{\"url\":\"https://.../cat.jpg\",\"type\":\"image\",\"schoolId\":\"xxx\"}"
```
（2026-10-28 起请求支持 `thumbUrl` 字段：传缩略图 URL 可把下载耗时从 ~10s 降到 <1s。）

---

## 4. 配置速查（server/.env / 环境变量）

代码读 `server/app/config.py`，全部走环境变量，默认值见下表。**本地保持默认**；以下是你最可能动的：

| 变量 | 默认 | 说明 / 何时改 |
|---|---|---|
| `API_TOKEN` | （空） | 调用 `/v1/*` 的鉴权头。本地 `real_test.py` 默认 `catcampus-local-dev-token` |
| `REID_ONNX` | 自动找 `models/reid.onnx` | 主干模型路径 |
| `DETECT_ONNX` | 自动找 `models/yolov8n.onnx` | 检测模型路径 |
| `INDEX_BACKEND` | `sqlite` | 特征库后端：`sqlite` 或 `cos`。**云托管无持久盘必须设 `cos`**（见铁律 6） |
| `INDEX_DB` | `/data/catcampus/index.sqlite3` | sqlite 后端落盘路径 |
| `MIN_SIM` | `0.62` | 候选最低相似度门槛。**`config.py` 与 `cloudfunctions/vision.js` 必须同值** |
| `TOP_N` | `2` | 返回候选数。**同上，两处必须同值** |
| `QG_MIN_AREA_RATIO` | `0.06` | 质量门控①：猫占图比低于此不出候选 |
| `QG_MIN_LIGHT_MEAN_V` | `125.0` | 质量门控②：框内平均亮度低于此判"太暗"，不出候选+花色弃权 |
| `REP_SPREAD_MIN` | `0.88` | 建档代表向量离散度阈值（只作用建档侧） |
| `FETCH_TIMEOUT` | `15` | 下载原图超时（秒）。缩略图优化后基本用不到 |
| `MAX_IMAGE_BYTES` | `10MB` | 原图大小上限 |
| `RECO_CACHE_TTL` | `600` | 识别结果缓存时长（秒），避免重复计算 |
| `COS_*` | （空） | `INDEX_BACKEND=cos` 时必填：`COS_SECRET_ID/KEY/BUCKET/REGION` |
| `FFMPEG` / `FFPROBE` | `ffmpeg` | 抽帧可执行路径 |

> 完整清单直接读 `server/app/config.py`（约 30 个 `_s/_i/_f/_b` 调用）。

---

## 5. web 管理后台的角色（可选，不要误以为必须）

`web/`（Vue3 前端 5173 + Spring Boot3 后端 8080）是**独立网页版管理台**，自带 H2 库，开箱即跑：

```bat
cd web/backend && mvn spring-boot:run "-Dspring-boot.run.arguments=--server.port=8080"
cd web/frontend && npm install && npm run dev
```
浏览器开 `http://localhost:5173/vision` → 上传猫照看候选/相似度，是最直观的识别可视化调试台。

**与 server 的关系**：web 的 `/vision` 页把请求经 Spring Boot 代理到 `server(8090)`。`server` 没起时页面显示「识别服务未连接」是预期行为。**你改 server 不需要起 web**；只有想"可视化看结果"或做"带业务的管理台"时才起它。

---

## 6. 改完 server 后的标准发布流程（铁律）

> ⚠️ **改了 `server/` 任何代码，都必须走打包+验证，否则线上跑旧包。**

1. **打包**（项目根执行，脚本写死 `SRC=server/`）：
   ```bat
   cd E:\Agent\project\stray-animals
   env\Scripts\python scripts\package_vision.py
   ```
   产物：`dist/catcampus-vision-YYYYMMDD.zip`（含 Dockerfile + app/ + models/）。
2. **硬验证**（解压到干净环境跑，防静默退化）：
   ```bat
   env\Scripts\python scripts\verify_vision_package.py
   ```
   必须看到 `provider=onnx`、`detector ON`、候选截断 `TOP_N=2`、缓存命中。任一项不过 = 打包有问题，禁止上线。
3. **上传云托管**：云托管控制台「代码包上传」选这个 zip，**替换识别服务**。
4. **云托管配置**：`--server.port` 不用管（注入 `PORT`）；**最大实例数锁 1**（保证 recocache / COS 特征库单实例正确）。
5. **上线后必做**：调一次 `initCollections`（建齐 15 个集合，根治 `-502005` 集合漏建）。

---

## 7. 改 server 的高频坑（务必先看）

1. **`x || 兜底` = 改了不生效头号元凶**：一律显式 `!== undefined && !== null`；服务端配置显式 `None` 判断。"没测过"≠0。
2. **坐标校验必须带 `isFinite`**：`typeof` 查不出 `NaN`。
3. **一只猫只存一条向量**（实测结论）：多向量在档案混错照时 top1 从 100%→29%。`REP_SPREAD_MIN=0.88` 控制代表向量选取。
4. **双维质量门控**（`engine._quality`）：占比 `QG_MIN_AREA_RATIO` + 低光 `QG_MIN_LIGHT_MEAN_V`。任一不过 → 不出候选+花色弃权（前端走"这张照片没法比对"）。**别想靠调 `MIN_SIM` 解决夜间问题**——夜间相似度方向会反。
5. **花色判定必要家族**（防误判，均在 `_decide`）：三花要 `orange≥ATTR_CALICO_MIN_ORANGE(0.05)`；狸花要 `warmish≥ATTR_TABBY_MIN_WARM(0.10)`（不限亮度，对曝光免疫）；奶牛要 `gray<ATTR_COW_MAX_GRAY(0.35)`。
6. **特征库后端**：代码默认 `sqlite`，但**云托管无持久盘必须设 `INDEX_BACKEND=cos` + 锁最大实例数=1**。不要误以为"SQLite 已弃用"——它仍是默认，只是云托管场景推荐切 cos。
7. **`MIN_SIM` / `TOP_N` 两处同值**：`server/app/config.py` 与 `cloudfunctions/catcampus/lib/vision.js` 必须一致。
8. **识别服务最小实例数=1**：避免冷启动（~6s）。若仍慢，根因通常是跨服务下载原图——已加 `thumbUrl` 缩略图优化（2026-10-28）。
9. **recocache 缓存**：同图同参数命中缓存秒回；调试时改了权重要清缓存或换参数。

---

## 8. 最小上手路径（10 分钟跑通）

```bat
REM 1) 起服务
cd E:\Agent\project\stray-animals\server
..\env\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8090

REM 2) 另开终端，健康检查
curl http://127.0.0.1:8090/health        REM ← 看到 provider=onnx 即成功

REM 3) 端到端验收（可选，确认推理正常）
..\env\Scripts\python tools\real_test.py

REM 4) 改完代码，跑单测 + 打包 + 验证
cd ..\server && ..\env\Scripts\python -m unittest discover -s tests -p "test_*.py"
cd .. && env\Scripts\python scripts\package_vision.py
env\Scripts\python scripts\verify_vision_package.py
```

改代码 → 单测绿 → 打包 → 验证绿 → 上传云托管（实例数锁 1）→ 调 `initCollections`。完成。
