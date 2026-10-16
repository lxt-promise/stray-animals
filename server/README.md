# CatCampus Vision —— 自建猫个体识别服务

给「喵园」小程序提供真正的图片 / 视频猫脸识别能力，替代掉原来的占位引擎。

> 📦 想部署到**微信云开发「云托管」**（CloudBase Run 容器）？见 [docs/识别服务云托管部署.md](../../docs/识别服务云托管部署.md)。`Dockerfile` 已改造为监听平台注入的 `PORT`、模型权重打包进镜像，可直接上传到云托管构建。  
> 可以用 Docker 起在任意一台自己的服务器（最简配：2 核 4G 纯 CPU 也能跑）。

---

## 先说一件重要的事：你不需要训练模型

很多人把「建特征库」和「训练模型」搞混了：

|          | 要做什么            | 需要多少数据              | 成本             |
| -------- | --------------- | ------------------- | -------------- |
| 训练模型     | 改网络权重           | 每只猫 30~50 张标注照，上百只猫 | GPU 跑几天 + 反复调参 |
| **建特征库** | 拿现成模型把照片变成向量存起来 | **零**               | 一次前向推理，毫秒级     |

本服务走的是第二条路。它用的骨干（MegaDescriptor / DINOv2）已经在海量数据上学会了  
「把一张图压缩成一个有区分度的向量」，我们只管把猫照片喂进去、把向量存 SQLite。  
校园几十只猫的规模，**冷启动当天就能用，不用等训练**。

## 模型选型

| 用途      | 推荐                       | 备选                                  | 说明                          |
| ------- | ------------------------ | ----------------------------------- | --------------------------- |
| 猫体检测    | YOLOv8n / YOLO11n ONNX   | 不检测（整图提特征）                          | 裁掉背景可显著提升准确率，避免模型「记住背景」     |
| 个体特征提取  | **DINOv2-base ONNX（量化）** | DINOv2-large（更准更慢）、MegaDescriptor-L | 已经在海量图像上学会了「把图压成有区分度的向量」    |
| 毛色 / 花纹 | CLIP 零样本分类               | 管理员手填                               | 用自然语言标签打分类，零标注；只做辅助展示，不决定身份 |

### 权重怎么拿：现成 ONNX vs 自己导出

HF 上 `BVRA/MegaDescriptor-*` **只提供 `pytorch_model.bin`**，要用必须先装 torch+timm 本地导出一次  
（几百 MB 依赖 + 1.2GB 权重下载）。而 Xenova 已经把 DINOv2 导出好 ONNX，**下载即用**：

| 模型                     | 量化版体积     | 本机（16 核 CPU）单图 | 适用                    |
| ---------------------- | --------- | -------------- | --------------------- |
| Xenova/dinov2-small    | 24 MB     | ~40 ms         | 先跑通链路                 |
| **Xenova/dinov2-base** | **91 MB** | ~100 ms        | **推荐起点**              |
| Xenova/dinov2-large    | 312 MB    | ~400 ms        | 猫数 > 50 再考虑           |
| MegaDescriptor-L-384   | 需自行导出     | 视配置            | 野生动物专用，论文称优于原生 DINOv2 |

```bash
# 国内访问 huggingface.co 通常不通，务必走镜像
export HF_ENDPOINT=https://hf-mirror.com
python tools/fetch_model.py      # → models/reid.onnx
```

> **许可注意**：MegaDescriptor 权重是 **CC BY-NC 4.0（禁止商用）**；  
> DINOv2 是 Apache-2.0，将来商业化没有法律风险。这也是默认选 DINOv2 的原因之一。

---

## 快速开始（Docker，推荐）

```bash
cd server
cp .env.example .env
# 至少改一个：API_TOKEN=你的强口令

# 1) 导出模型权重（需要一次 Python 环境 + 联网）
pip install torch timm ultralytics onnx
python tools/export_onnx.py --model mega-l --out models/reid.onnx --size 224
python tools/export_onnx.py --yolo --weights yolov8n.pt

# 2) 回填 .env
#    REID_ONNX=/app/models/reid.onnx   REID_SIZE=224
#    DETECT_ONNX=/app/models/yolo.onnx   # ⚠️ 见下方「检测模型」注意事项

# 3) 起服务
docker compose up -d --build
curl http://127.0.0.1:8000/health
```

返回里 `provider` 是 `onnx` 说明模型加载成功；是 `hash` 说明在跑占位引擎（检查模型路径有没有挂进去）。

### ⚠️ 检测模型（DETECT_ONNX）的坑

**默认不要配**（留空 = 整图提特征）。曾经配上后线上 100% 复现 500：

```
onnxruntime ... Add node '/embeddings/Add'
Attempting to broadcast an axis by a dimension other than 1. 257 by 1370
```

原因不是模型坏了，是「检测框裁出来的 crop」长宽比和原图差很多时，预处理里的
letterbox 缩放系数若按**原图**尺寸算就会失效，把 crop 的一边缩得远超输入边长
（224 的模型收到 1370 宽）。修复后 `_letterbox` 一律按**传进来的那张图**算缩放，
`_to_nchw` 出口再自检形状（不对就报「期望 (1,3,224,224)，实际 …」，一眼定位）。

真要开检测裁剪，注意两点：
1. `DETECT_COLLAPSE_SQUARE=true` 时会把框扩成正方形（默认 false）；
2. 改完先跑 `python server/tests/test_engine_shape.py`（12 项，不依赖 onnxruntime）。

没有模型也想先跑通链路？直接 `docker compose up -d` 即可，服务会自动降级到占位引擎。

## 不用 Docker（Windows 本机开发，推荐）

没有 Docker Desktop、也没有 NVIDIA 显卡？完全不影响，CPU + ONNX Runtime 就能跑。

```bat
cd E:\Agent\project\stray-animals

:: 1) 建虚拟环境并安装依赖
E:\Agent\WorkBuddy\binaries\python\versions\3.13.12\python.exe -m venv env
env\Scripts\python -m pip install -r requirements.txt

:: 2) 下载现成 DINOv2 ONNX 权重（走国内镜像）
set HF_ENDPOINT=https://hf-mirror.com
python tools\fetch_model.py

:: 3) 配 .env（本机已有一份可直接用：ffmpeg 路径已指向你那份解压的 ffmpeg）
::    关键是 REID_ONNX=models/reid.onnx 与 FFMPEG/FFPROBE 的绝对路径

:: 4) 启动 —— 必须在 server\ 目录下，因为 .env 和相对路径按当前目录解析
..\env\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8090

:: 5) 验证
curl http://127.0.0.1:8090/health
```

也可以直接双击 `start.bat`。

返回里 `provider` 是 `onnx` 说明模型加载成功；是 `hash` 说明在跑占位引擎（检查模型路径有没有写对）。

```bash
# Linux / macOS
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

## 接口

统一用 `Authorization: Bearer <API_TOKEN>`。

| 接口                     | 用途                               |
| ---------------------- | -------------------------------- |
| `GET /health`          | 健康检查：引擎类型、向量维度、ffmpeg 可用性、已入库猫数  |
| `POST /v1/recognize`   | **主接口**，云函数配的 `AI_ENDPOINT` 就指向它 |
| `POST /v1/embed`       | 单图抽向量，调试用                        |
| `POST /v1/index/build` | 批量建库，把每只猫多张照片平均成代表向量             |

### /v1/recognize 请求体

```json
{
  "url": "https://...临时链接.jpg",
  "videoUrl": "https://...临时链接.mp4",
  "type": "image",
  "frames": 1,
  "schoolId": "sch001",
  "cats": [{ "id": "cat001", "name": "橘座", "pattern": "tabby", "color": "狸花",
             "photos": ["https://...档案照.jpg"] }]
}
```

响应与 `cloudfunctions/catcampus/lib/vision.js` 的契约一致，前端不需要改一行代码。

---

## 和小程序对接

在云函数 `catcampus` 的环境变量里配两项即可：

```
AI_ENDPOINT = https://ai.yourdomain.com/v1/recognize
AI_TOKEN    = 与服务端 API_TOKEN 相同
AI_TIMEOUT_MS = 15000
```

> 云函数出网不受小程序 `request 合法域名` 限制，所以**小程序不需要配服务器域名**。  
> 但服务端仍然要 `https + 已备案域名`，因为腾讯侧要求 + 你得防中间人。

**首次上线记得建一次库**（云函数action `buildAiIndex`，管理员在小程序端触发，或用命令行脚本）：

```bash
python tools/build_index.py --server https://ai.yourdomain.com --token xxx cats.json
```

---

## 云托管部署：特征库持久化（COS 后端）

云托管**没有持久盘**，默认 `INDEX_BACKEND=sqlite` 写的 `/data/catcampus/index.sqlite3` 在容器重建后会归零。
特征库是可再生数据，不会出错，但每次重建都要重新下载全部猫照片重算一遍。
想让特征库跨重建存活，就切到 COS 对象存储后端：**每只猫一个对象** `index/<cat_id>.bin`。

### 1) 建桶（必须和云托管同地域）

> ⚠️ **别用微信云托管控制台里自带的「对象存储」**（`tcb.qcloud.la` 域名那套）。
> 它属于云开发（TCB）体系的托管存储：虽然底层也是 COS，但官方明确**不支持用 COS SDK/控制台/CAM 永久密钥
> 直接操作它**，服务端只开放「临时密钥 + 开放接口」一条路，与本服务的 `COS_SECRET_ID/KEY` 模式不兼容，
> 填进去会 403。要建的是**腾讯云控制台**的标准 COS 桶（同一个账号，入口不同）。

[对象存储控制台](https://console.cloud.tencent.com/cos/bucket) → 存储桶列表 → 创建存储桶：

| 项 | 填什么 |
|---|---|
| 名称 | `catcampus`（控制台只填自定义部分即可） |
| 地域 | **上海**（和你的云托管服务同地域，地域创建后不可改） |
| 访问权限 | **私有读写**（服务端用密钥签名访问，不需要公开读） |

建好后，桶的**完整名字**是 `catcampus-<你的APPID>`，如 `catcampus-1250000000`。
APPID 在控制台右上角「账号信息」里能看到。

### 2) 拿密钥（别用主账号密钥）

[访问密钥](https://console.cloud.tencent.com/cam/capi) → 新建密钥，得到一对值：

- `SecretId`：`AKID` 开头的一长串
- `SecretKey`：一串随机字符，**只在创建时展示一次**，当场复制

> ⚠️ 主账号密钥泄露 = 整个腾讯云账号沦陷。正确姿势是建子账号：
> [CAM 控制台](https://console.cloud.tencent.com/cam) → 用户 → 新建用户 → 访问方式选「编程访问」
> → 在子账号的「API 密钥」页签新建密钥 → 只关联下面这条自定义策略（替换 APPID 和桶名）：
>
> ```json
> {
>   "version": "2.0",
>   "statement": [
>     {
>       "effect": "allow",
>       "action": [
>         "name/cos:GetObject",
>         "name/cos:PutObject",
>         "name/cos:DeleteObject",
>         "name/cos:HeadObject",
>         "name/cos:GetBucket"
>       ],
>       "resource": [
>         "qcs::cos:ap-shanghai:uid/1250000000:catcampus-1250000000/",
>         "qcs::cos:ap-shanghai:uid/1250000000:catcampus-1250000000/index/*"
>       ]
>     }
>   ]
> }
> ```
>
> 其中 `name/cos:GetBucket` 是冷启动时 `list_objects` 需要的，**漏了会 403**。
> 嫌麻烦就关联系统策略 `QcloudCOSDataFullControl`（权限面大一些，但仍限定在 COS 数据面）。

### 3) 填环境变量

云托管控制台 → 服务 → 服务配置 → 环境变量，逐条新增（Key / Value 两栏）：

| 变量 | 值 | 说明 |
|---|---|---|
| `INDEX_BACKEND` | `cos` | 切到 COS 后端。不填 / 填 `sqlite` = 本地文件 |
| `COS_SECRET_ID` | `AKIDxxxx...` | 上一步的 SecretId |
| `COS_SECRET_KEY` | `xxxx...` | 上一步的 SecretKey |
| `COS_BUCKET` | `catcampus-1250000000` | ⚠️ **必须带 APPID 后缀**，只填 `catcampus` 会报 NoSuchBucket |
| `COS_REGION` | `ap-shanghai` | 桶所在地域英文代号，必须和桶一致 |
| `COS_TOKEN` | （留空） | 只有临时密钥 STS 才需要 |
| `COS_ENDPOINT` | （留空） | 走默认公网域名；配了 VPC 想走内网再填 |
| `INDEX_PREFIX` | `index/` | 对象键前缀，一般不用改 |

注意：
- 值里**不要加引号**、不要有前后空格；变量名区分大小写
- 改完环境变量**必须重新部署版本**才生效
- 建议同时把**最大实例数设为 1**（单写者，缓存模型严格正确），最小实例数保持 0 省钱

### 4) 验证

```bash
curl https://ai.yourdomain.com/health
# {"ok":true,"provider":"onnx","dim":768,"ffmpeg":false,"indexed":42,"indexBackend":"cos_store"}
```

`indexBackend` 必须是 **`cos_store`** —— 如果是 `sqlite_store` 说明环境变量没生效。
然后在小程序端「重建特征库」一次，记下 `indexed`，**重新部署服务**后再访问 `/health`，数字不归零 = 持久化生效。

常见报错速查：

| 现象 | 原因 |
|---|---|
| 日志 `INDEX_BACKEND=cos 但缺少配置: COS_BUCKET` | 环境变量没生效（重新部署了吗？名字拼错了吗？） |
| `NoSuchBucket` | 桶名漏了 `-1250000000` 后缀，或地域填错 |
| `AccessDenied` / 403 | 子账号策略没给全（尤其 `name/cos:GetBucket`），或桶名/地域写错 |
| `SignatureDoesNotMatch` | SecretKey 复制时多了空格 |
| 能写但重启后归零 | 其实还是 sqlite 后端，看 `/health` 的 `indexBackend` |

> 后端行为有 25 项测试兜底：`env/Scripts/python.exe server/tests/test_index_store.py`

---

## 自检

两套脚本，先跑链路再验模型：

```bash
# 1) 链路自检：不需要模型/GPU/Docker，验证管道通不通（实测 PASS 22 / FAIL 0）
python tools/smoke_test.py

# 2) 真实模型 × 真实猫照片验收：要求 provider == onnx（实测 PASS 15 / FAIL 0）
python -m uvicorn app.main:app --host 127.0.0.1 --port 8090   # 终端 A
python tools/real_test.py                                      # 终端 B

# 3) 若换了骨干网络，重新标定阈值
python tools/_realcat_probe.py
```

> `smoke_test.py` 验证的是"管道通不通"，会退化到占位引擎；  
> `real_test.py` 才证明"真模型确实接管了"——它用真实猫照片（HF 官方四格图拆成 4 只个体）  
> 叠加旋转/明暗/裁切/模糊，校验 **同猫高分、异猫低分、无关图归零** 三条性质。

### 阈值标定（重要）

不同骨干网络的相似度分布差异很大。`SIM_LOW` / `SIM_HIGH` 已用真实照片标定：

| 场景                 | 实测余弦相似度（DINOv2-base ONNX） |
| ------------------ | ------------------------- |
| 同一只猫 + 旋转/翻转/明暗/模糊 | 0.960 ~ 0.996             |
| 不同猫之间              | 0.745 ~ 0.926             |
| 猫 vs 完全无关图片        | 0.509 ~ 0.551             |

早期版本填 `0.40 / 0.85`，因 **0.85 低于「不同猫」的真实上限 0.926**，导致任意两只猫都打满 99 分、检索失效。现改为 `0.70 / 0.96`。**换模型后请重跑 `tools/_realcat_probe.py` 重标**。

### 其它随手可用的检查脚本

| 脚本                     | 用途                                              |
| ---------------------- | ----------------------------------------------- |
| `tools/env_check.py`   | 环境体检：Python 版本、ffmpeg/GPU 有无、wheel 兼容性、源站连通性、磁盘 |
| `tools/wheel_probe.py` | 精确查询某包是否有匹配当前 Python 的 wheel（注意要用子串匹配，别用 split） |
| `tools/onnx_probe.py`  | 探测 HF 上哪些仓库有现成 ONNX 权重                          |
| `tools/fetch_model.py` | 下载权重，支持**断点续传**（中途被杀也不用从头再来）                    |
| `tools/export_onnx.py` | 有 torch 时，把 MegaDescriptor 导出成 ONNX             |

## 视频识别

这是自建相对云函数最大的优势：微信云函数的 Node 环境**没有 ffmpeg**，  
以前只能用封面帧凑合；自建服务器可以任意装系统包，真抽帧。

流程：`ffprobe` 读时长 → 按「总时长 / 目标帧数」定抽帧速率 → 抽最多 8 帧 →  
每帧独立检测提取 → **向量平均后再归一化** → 检索。多帧平均比单帧稳得多。

---

## 性能参考

| 环境       | ReID 单图           | + 检测    | 并发      |
| -------- | ----------------- | ------- | ------- |
| 4 核 CPU  | 150~400 ms（S-224） | +100 ms | 2~4 QPS |
| RTX 4090 | <15 ms            | +10 ms  | 50+ QPS |

校园项目日活几百次，CPU 就够。  
腾讯云 / 阿里云 4 核 8G 云主机（或轻量应用服务器）月付几十到两百块即可跑住；GPU 按需环境下的 L20/4090 主机月付几百到一两千，除非猫数量上百或做了公开访问再考虑。

## 准确率校准

不同模型、不同猫群的最佳阈值不一样。上线后用真实照片校准一次：

- 同一只猫不同照片的余弦相似度 **偏低于 0.5** → 调低 `SIM_LOW`
- 不同猫之间相似度 **高于 0.6** → 调高 `SIM_LOW`，并压缩 `SIM_HIGH`

这两个值在 `app/main.py` 顶部。前端已经做了「Top-5 候选 + 低置信提示 + 人工确认」，  
所以准确率不完美的代价只是多一次点击，不会认错猫还硬判。

## 什么时候才真的需要训练

同时满足再动：① 每只猫攒够 20 张以上不同角度照片；② 猫总数 100 只以上；  
③ 实际反馈里**同花色猫频繁认错**（三只橘猫总混）。  
那时也不是从零训：在 MegaDescriptor 基础上接一层分类头做微调，消费级 GPU 几小时搞定。  
而你现在每次「识别 → 用户点确认」都在自动攒训练集（`ai_samples` 集合），样本是免费增长的。
