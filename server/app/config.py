"""统一配置读取。所有开关都能用环境变量覆盖，方便 Docker 部署时注入。"""
import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # dotenv 非必需
    pass


def _s(key: str, default: str = "") -> str:
    v = os.getenv(key, default)
    return v.strip() if isinstance(v, str) else v


def _i(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, default))
    except (TypeError, ValueError):
        return default


def _f(key: str, default: float) -> float:
    try:
        return float(os.getenv(key, default))
    except (TypeError, ValueError):
        return default


def _b(key: str, default: bool = False) -> bool:
    return _s(key, "1" if default else "0").lower() in ("1", "true", "yes", "on")


API_TOKEN = _s("API_TOKEN")
DEVICE = _s("DEVICE", "auto")

REID_ONNX = _s("REID_ONNX")
# ⚠️ 默认 224 对应镜像里那版 reid.onnx（patch=14，token 数 257）。
# 换成别的骨干后即使这里没改也不会 500 —— engine._probe_input_size 会按模型
# 输出的 token 数反推边长并用一次空推理校验。REID_SIZE 只是「首选值」。
REID_SIZE = _i("REID_SIZE", 224)
# 特征算法版本：骨干 / 归一化 / 池化策略变更时递增。写进 COS 对象头（1 字节），
# 读取时版本不符的对象直接跳过 —— 防止换算法后新旧向量（同维不同义）混算乱匹配。
#   v1 = mean-pool, v2 = DINOv2 CLS (ImageNet 归一化),
#   v3 = 支持 MegaDescriptor（[0.5,0.5,0.5] 归一化）,
#   v4 = 切换 MegaDescriptor 上线时的干净重建基线（2026-10-31）：
#        过渡期若有节点在模型切换完成前以 v3 标签写过 DINOv2 语义的向量，
#        也会被一并隔离。
FEATURE_POOL_VERSION = _i("FEATURE_POOL_VERSION", 4)
# ReID 骨干的归一化口径。MegaDescriptor 系列用 [0.5,0.5,0.5]（half），
# DINOv2 等通用骨干用 ImageNet 均值方差。REID_ONNX 指向哪类模型就配哪种，
# 配错会让向量全部偏到一个角落、同猫余弦只剩 0.3 以下。
REID_NORM = _s("REID_NORM", "imagenet")
REID_TORCH = _s("REID_TORCH", "timm/vit_large_patch14_dinov2.lvd142m")

DETECT_ONNX = _s("DETECT_ONNX")
# 留空时自动发现 models/yolov8n.onnx（随仓库发布）。要彻底关掉检测有两种方式：
#   DETECT_ONNX=off  或  DETECT_AUTO=0
# 「自动发现」是为了让部署少一个必填项 —— 漏配环境变量是「代码改了线上没生效」
# 最常见的来源；而显式关闭的开关依然在，不存在关不掉。
DETECT_AUTO = _b("DETECT_AUTO", True)
DETECT_CONF = _f("DETECT_CONF", 0.35)
# 检测框外扩比例。检测框天生贴得紧，耳尖/尾巴常被切在框外；外扩 8% 能把它们带回来，
# 又不会明显带进背景。调大就会重新引入「背景污染」，别超过 0.15。
DETECT_PAD = _f("DETECT_PAD", 0.08)
# 检测到的猫框是否**折叠成正方形**再裁剪。
#
# 为什么出厂默认 false（true 会在生产上引发 500，2026-10-15 实测）：
# embedder 按传给它的图片**自己的**尺寸算 letterbox 缩放系数（s = size/max(w,h)），
# 所以「先按框裁出任意长宽比的 crop、再交给 embedder」是正确的；
# 而一旦把框折成正方形（为了不让整图提特征跑偏），裁出的 crop 尺寸就和原图脱钩，
# 极端框（如 518×293）会让缩放系数失效、缩放后的一边远超模型输入边长，
# ONNX 直接报 "Attempting to broadcast an axis by a dimension other than 1. 257 by 1370"。
# 想开启的部署必须同时确认 embedder 用 crop 尺寸算缩放（本代码已如此），
# 并接受「整图提特征」这条路径本身没有裁剪收益。
DETECT_COLLAPSE_SQUARE = _b("DETECT_COLLAPSE_SQUARE", False)

# ---------------- 前景抠图（u2netp）----------------
#
# 检测框里仍有墙/地板/床单，这些背景像素会把花色统计与个体特征一起带偏
# （实测：白背景前的纯黑猫被判成奶牛猫；同一只猫换背景后余弦 0.54→0.72）。
# 抠图后只留猫毛像素：色域统计只数猫毛，提特征用中性灰底。
# 自动发现 models/u2netp.onnx；MATTING_ONNX=off 可整体关闭（关闭后行为与旧版一致）。
MATTING_ONNX = _s("MATTING_ONNX")
MATTING_AUTO = _b("MATTING_AUTO", True)
# 掩膜阈值：> 它的像素算前景。0.5 是显著度归一化后的自然分界。
MATTING_ALPHA_THR = _f("MATTING_ALPHA_THR", 0.5)
# 合成背景灰度（提特征用）。128 = ImageNet 归一化后的 0，无信息背景。
MATTING_BG = _i("MATTING_BG", 128)
# 色域统计是否只用前景像素（关掉=退回旧的全框统计）
MATTING_MASK_ATTR = _b("MATTING_MASK_ATTR", True)
# 提特征前是否把背景换成灰底（关掉=退回旧的全框裁剪）
MATTING_MASK_EMBED = _b("MATTING_MASK_EMBED", True)
# 抠图覆盖率低于此值时，认为 u2netp 把猫体弄丢了（常见于：提亮后的白猫
# 白毛与背景同色，掩膜覆盖率从 40% 跌到 5%）。此时**不**用灰底合成图提特征
# —— 合成出来几乎是纯灰，特征向量会塌缩成噪声，与原图余弦降到 0.01。
# 退回原始 crop 虽然带进背景，但至少保留了猫体像素，特征还能用。
# 0.10 的依据：19 张实拍正常猫覆盖率 0.20~0.55；提亮后白猫跌到 0.046。
MATTING_MIN_COVERAGE = _f("MATTING_MIN_COVERAGE", 0.10)

USE_CLIP = _b("USE_CLIP")
CLIP_MODEL = _s("CLIP_MODEL", "ViT-B-32")
CLIP_PRETRAINED = _s("CLIP_PRETRAINED", "laion2b_s34b_b79k")

# ---------------- 属性识别（毛色 / 花纹 / 花色类型）----------------
#
# 属性有两个来源，按顺序尝试：
#   1. CLIP 零样本分类（USE_CLIP=1，要 torch，镜像 +600MB，线上通常没开）
#   2. app/attrs.py 的纯 numpy 启发式（零依赖、~5ms、确定性）
# 第 1 条不可用、或置信度低于 ATTR_CONF_MIN 时**自动落到第 2 条**。
# 早于此的版本两者都没有兜底：CLIP 没开 → 界面只有「检测 / 帧数」两张卡，
# 用户上传白猫看不到任何毛色信息（2026-10-17 现场问题）。

# CLIP 结果低于此置信度就改用启发式。
# 0.5 是用户提的线（"置信度低于 50% 就调特征识别"）：CLIP 在零样本下
# 对 9 个毛色 × 6 个花纹做 softmax，50% 以下基本等于"猜的"。
ATTR_CONF_MIN = _f("ATTR_CONF_MIN", 0.5)

# ---------------- 本地识别方法（2026-11-10）----------------
#
# CLIP 不可用 / 置信度不足时，本地用哪套算法：
#   pattern → tools/pattern_recognize.py：6 色桶 + 分带布局 + 斑块度 +
#             边缘肤色剔除（"看图说话"口径，默认；20 张实拍 20/20、
#             16 张标准照 16/16）
#   legacy  → app/attrs.py：8 色桶 + 条纹频率 + 曝光平移（18/20、15/16）
#
# 两套算法输出契约完全一致（color/pattern/breed/confidence/palette/
# reason/refused），所以切换只影响判定口径，不影响 engine/search/前端。
# pattern 加载失败时**自动回退 legacy**，不会让整条识别链失败。
# 回退 legacy 只需改这一行重启：ATTR_ENGINE=legacy
ATTR_ENGINE = (_s("ATTR_ENGINE", "pattern") or "pattern").lower()

# 条纹显著度门槛（0~1）。低于它判 solid。
# 0.60 是频率法实测标定的分界（8 张真实猫照）：
#   真条纹（狸花）带数 11+ / 调制 0.63+ → 得分 0.9+；
#   黑白斑块（奶牛）的边界只有 1~3 条交替带 → 得分 ≤0.55；
#   纯色 → 0。旧阈值 0.35 会把奶牛斑块误判成虎斑。
ATTR_STRIPE_MIN = _f("ATTR_STRIPE_MIN", 0.60)

# 有效"猫色"像素占画面的最低比例。低于它说明猫太小 / 背景太杂，
# 此时**返回空而不是硬编一个颜色** —— 伪造属性比没有属性危害大。
ATTR_MIN_COVERAGE = _f("ATTR_MIN_COVERAGE", 0.22)

# ---------------- 照片可用性门控（2026-11-05）----------------
#
# 为什么单独设一层：色域阈值再准，也只能在「花色看得出来」的照片上生效。
# 糊片、极小主体、几乎全黑的照片里，直方图统计本身就没有信息 —— 此时
# 任何花色结论都是噪声，还会被前端当成确定结果展示。这一层的职责是
# **先回答「这张照片能不能用来判断花色」**，不能就返回空 + 重拍提示，
# 把「算法判错」和「素材不可用」分开。
#
# 阈值全部按**真实素材的保守下限**标定（34 张：18 张实拍 + 16 张标准照）：
#   清晰度（512 长边、前景区域 Laplacian 方差）：34 张实测 13~2300，其中
#       最低的「橘猫-遮挡0」是 13（小裁剪、毛面平滑，不是糊片）；人工模糊
#       r=6 后全部掉到 1~3。两簇间隔极大，门槛取 10 —— 只拦「明显糊成一片」
#       的图，不碰任何可用的实拍/标准照。
#   前景占比（掩膜 0.5 以上像素 / 画面）：实测最低 2.2%（橘猫-遮挡0）与
#       3.2%（白猫-黑天-猫小背景大），门槛取 0.5% 只拦「掩膜几乎全空 /
#       猫被完全挡住」的极端情况。
# 关掉整层：ATTR_QUALITY_GATE=0（排查误拦时用）。
ATTR_QUALITY_GATE = _b("ATTR_QUALITY_GATE", True)
ATTR_MIN_SHARP = _f("ATTR_MIN_SHARP", 10.0)
ATTR_MIN_FG = _f("ATTR_MIN_FG", 0.005)
# 清晰度计算的长边上限：全分辨率算 Laplacian 对大图太贵，512 已足够区分
# 「有毛发的细节」和「糊成一片」（见上面 r=6 的实测数据）。
ATTR_SHARP_SIZE = _i("ATTR_SHARP_SIZE", 512)

# ---------------- L1 稳健统计（2026-11-05）----------------
#
# 全局色桶直方图不抗局部污染（手/衣袖/毯子被抠进掩膜就改写全局比例）。
# 开 ATTR_ROBUST_STATS 后，掩膜模式会把分析网格切成 3×3 瓦片，
# 剔除与「全体瓦片分量中位数」显著不一致的瓦片再汇总（attrs._robust_reweight）。
# 阈值是相对量（MAD 倍率 + 绝对下限），不随素材走，不需要逐图调：
#   ATTR_ROBUST_TILE     瓦片网格（每边块数），3 = 3×3
#   ATTR_ROBUST_MIN_TILE 瓦片内猫体占比低于它则该瓦片不参与（样本太少不可靠）
#   ATTR_ROBUST_DIST     L1 距离绝对下限（瓦片色板与整体差这么多才算离群）
#   ATTR_ROBUST_MAD      距离中位数的倍率下限（猫有两种主色时两群都大，不会被误剔）
ATTR_ROBUST_STATS = _b("ATTR_ROBUST_STATS", False)
ATTR_ROBUST_TILE = _i("ATTR_ROBUST_TILE", 3)
ATTR_ROBUST_MIN_TILE = _f("ATTR_ROBUST_MIN_TILE", 0.3)
ATTR_ROBUST_DIST = _f("ATTR_ROBUST_DIST", 0.25)
ATTR_ROBUST_MAD = _f("ATTR_ROBUST_MAD", 3.0)

# ---------------- 口径一致性门控（2026-11-05）----------------
#
# 遮挡会同时破坏两件事：手被抠进掩膜（暖色暴涨）、过曝白毛被抠掉（白色暴跌），
# 叠加后黑白猫会滑进橘猫分支（实测「奶牛猫-有人手干扰-裁剪.jpg」）。
# 开这个开关后，analyze() 会再算一次「不套掩膜」的整幅统计：
#   两口径**互斥**（hard_exclusive：物理上不可能同时成立）
#   且 ATTR_MASK_EXTENT_MIN 判定抠图横向不完整
#   → 弃权（返回空 + 重拍提示），而不是选一个。
# 实测 35 张真实素材：只有用户反馈的那一张命中，其余 34 张结论不变。
# 注意 extent 不能单独用：奶牛猫3 / 橘猫-遮挡0 只有 0.36 但结论是对的。
ATTR_CONSISTENCY_GATE = _b("ATTR_CONSISTENCY_GATE", True)
ATTR_MASK_EXTENT_MIN = _f("ATTR_MASK_EXTENT_MIN", 0.70)

# 曝光自适应（2026-10-25）：色桶的亮度阈值整体平移，抵消拍摄曝光差异。
#   REF  = 标准曝光下「V 的 98 分位」参考值（实测正常照片 200~220）
#   GAIN = 跟随比例，<1 表示不完全跟随（留一部分真实曝光差，避免过度校正）
#   MAX  = 平移幅度上限（防止极端曝光把阈值推出合理区间）
# 关掉自适应：ATTR_EXPOSURE_GAIN=0
ATTR_EXPOSURE_REF = _f("ATTR_EXPOSURE_REF", 210.0)
ATTR_EXPOSURE_GAIN = _f("ATTR_EXPOSURE_GAIN", 0.6)
ATTR_EXPOSURE_MAX = _f("ATTR_EXPOSURE_MAX", 45.0)

# 属性分析用的缩略图边长。96 已有 9216 个样本，再大只是浪费 CPU。
ATTR_ANALYZE_SIZE = _i("ATTR_ANALYZE_SIZE", 96)

# 可选的远程属性识别接口（自建服务 / 公开 API / 云函数）。
# 留空 = 纯本地离线运行，不发任何网络请求。协议见 app/attrs.py 的 _remote()。
# 远程失败会自动降级到本地启发式，不会成为单点故障。
ATTR_API_URL = _s("ATTR_API_URL")
ATTR_API_TOKEN = _s("ATTR_API_TOKEN")
ATTR_API_TIMEOUT = _i("ATTR_API_TIMEOUT", 4)

# 身份识别的最低可采信分（0~99，与云函数 LOW_CONF 同口径）。
# 低于它时 recognize 返回 features.identified=false —— 前端据此把文案
# 从"这是某某"改成"没认出来，但看起来是……"，属性信息照样展示。
#
# ⚠️ 这个数字必须和 SIM_MID 配套看，不能单独调。
# 历史值 50 配上老的线性窗口（0.75~0.90），等价于「余弦 ≥ 0.825 才认得出」——
# 而现场同一只猫的另一张照片只有 0.763（见 SIM_MID 的推导），结果就是
# **排序对了、分数 9%、还判定「没认出来」**。现在 45 分 ≈ 余弦 0.745，
# 正好落在「同猫不同构图」的下沿。
IDENTIFY_MIN = _i("IDENTIFY_MIN", 45)

INDEX_DB = Path(_s("INDEX_DB", "/data/catcampus/index.sqlite3"))

# 特征库后端：sqlite（本地文件，默认）| cos（腾讯云对象存储）。
# 云托管等无持久盘环境必须用 cos，否则容器一重建特征库就归零。
INDEX_BACKEND = _s("INDEX_BACKEND", "sqlite")
# COS 后端参数（INDEX_BACKEND=cos 时必配前四个）
COS_SECRET_ID = _s("COS_SECRET_ID")
COS_SECRET_KEY = _s("COS_SECRET_KEY")
COS_TOKEN = _s("COS_TOKEN")              # 仅临时密钥场景需要
COS_BUCKET = _s("COS_BUCKET")
COS_REGION = _s("COS_REGION")            # 如 ap-shanghai
COS_ENDPOINT = _s("COS_ENDPOINT")        # 一般留空走默认；VPC 内可填内网 endpoint
# COS 内的对象键前缀，每猫一对象：<INDEX_PREFIX><cat_id>.bin
INDEX_PREFIX = _s("INDEX_PREFIX", "index/")

# 检索候选的最低相似度门槛（**原始余弦**，属性补偿前）：低于此值的猫不进入候选列表。
#
# 为什么必须有：早期 search() 对全库排序后直接取 Top-N，**没有任何阈值**。
# 特征库里只有 1 只猫时，无论上传什么图都会返回「那 1 只」——
# 实测用户上传白猫，返回库里唯一的小黑，展示分 0%、特征相似度 48.7%，
# 但在界面上它照样是「匹配候选 Top1」，用户读到的结论是「这是小黑」。
# 48.7% 属于「完全无关」（无关图 0.51~0.55），必须挡掉。
#
# ⚠️ 0.62 → **0.30**（2026-10-31，MegaDescriptor-T 换骨干后重标定）。
# 旧 0.62 是 DINOv2 时代的阈值（同图变换 0.96、异猫 0.745）；MegaDescriptor 的
# 余弦**整体下移**：实测 8 张东南大学实拍图里，正确档案（同猫不同照片）
# 只有 0.364~0.667，而最高分候选往往正是真匹配 —— 0.62 会把 7/8 张真匹配
# 直接挡在门外（现场表现为「特征识别对了，但没能匹配到已有档案」）。
# 0.30 低于实测正确候选的下沿（0.364），保证真匹配一定进候选；
# 误匹配由展示分（IDENTIFY_MIN）+ 属性硬过滤兜底，不靠这条粗筛。
MIN_SIM = _f("MIN_SIM", 0.30)

# ---------------- 余弦 → 展示分（校准曲线）----------------
#
# 历史做法是**线性窗口**：score = (sim - SIM_LOW) / (SIM_HIGH - SIM_LOW) * 100，
# 窗口取 0.75~0.90（按「同图变换 0.96~0.996、不同猫 0.745~0.926」标定）。
# 真实现场（2026-10-24 反馈）：**同一只猫的另一张照片只有 0.763** ——
# 正好落在窗口起点附近，被压成 9 分；而排序其实是对的（次名 0.698 → 0 分）。
#
# 线性窗口的根因缺陷：它假设「同猫必 > 0.90」。但摄影条件（室内暖光、
# 换背景、换姿态、几个月长胖）会把同猫压到 0.74~0.85，这段又与「不同猫」的
# 0.62~0.80 大面积重叠 —— 任何**硬边界**都会把大量真匹配判死。
#
# 换成 logistic：单调、无死区、边界软。
#     score = 99 / (1 + exp(-(sim - SIM_MID) * SIM_SLOPE))
#
# ⚠️ 2026-10-31 随 MIN_SIM 一起重标定（MegaDescriptor 的余弦分布比 DINOv2 整体下移）：
# SIM_MID=0.42：实测「同猫另一张照片」0.364~0.667 的中位附近，
# SIM_SLOPE=25：在 0.30~0.60 给出接近线性的响应，两端饱和。
# 参照点（8 张实拍查询的正确候选余弦 → 展示分）：
#   0.364→20 / 0.408→42 / 0.431→56 / 0.488→84 / 0.506→89 / 0.556→96 /
#   0.648→99 / 0.667→99
# 配 IDENTIFY_MIN=45：余弦 ≥0.413 才判「认出来了」，0.364~0.408 仍显示候选但
# 标注「没认出来」—— 宁可让用户自己确认，也不把 43 分硬说成确定的同一只猫。
SIM_MID = _f("SIM_MID", 0.42)
SIM_SLOPE = _f("SIM_SLOPE", 25.0)
# 展示分上限。留 1 分不给满分：余弦 1.0 只可能是「同一张图」，
# 那次识别没有信息量，不该显示成「100% 确定」。
SCORE_CAP = _i("SCORE_CAP", 99)

# ---------------- 候选条数 ----------------
#
# 只返回 Top-2（2026-10-25）。理由：
#  ① 第 3 名及以后几乎不可能是答案。余弦是「整体像不像」，同一只猫在不同构图下的
#     相似度通常比第 2 名高出 0.03~0.08；排到第 3 名意味着它的余弦已经低于
#     MIN_SIM 附近，展示分是个位数 —— 用户看到「3% 的可能是它」得不到任何信息。
#  ② 候选是**给用户做二选一**的。超过 2 条时，用户要么只看第一条（后面的白算），
#     要么在一堆低分行里挑花眼；而真正有价值的永远是「是它 / 还是那只长得像的」。
#  ③ 少而准 > 多而杂。候选多了，Top1 被低分候选稀释，lead（领先次名的幅度）
#     这个诊断口径也会被拉平，排查「为什么分这么低」反而更难看。
# 想临时放回 5 条排查候选分布，设环境变量 TOP_N=5 即可，不用改代码。
TOP_N = _i("TOP_N", 2)

# Top1 与次名的相似度差小于该值时，认为“分不出来”，压低置信度而不是硬判。
GAP_CLEAR = _f("GAP_CLEAR", 0.05)
# 分不出来时的最低折算系数（历史值 0.5 —— 直接砍半，实测太狠：
# 0.05 的差距在 0.76 附近只是噪声，砍半会让真匹配从 56 分掉到 28 分）。
GAP_FLOOR = _f("GAP_FLOOR", 0.75)

# ---------------- 花色一致性重排 ----------------
#
# 余弦只吃「像素整体像不像」，而个体身份有一半证据在**花色**上：
# 橘猫 vs 奶牛猫，再像也不可能是同一只。档案里本来就有 `pattern`
# （花色枚举，与前端的 PATTERN 同值域），识别侧也刚算出了 query 的花色。
#
# ⚠️ **默认关闭**，这是量出来的结论，不是保守：
# 2026-10-24 用 8 张真实照片（东南大学猫）做留一法，启发式花色把
# 「室内站立拍摄的黑白奶牛猫」判成 gray/tabby（背景灰布 51% 被算成猫身灰，
# 白毛只剩 7.7%），而档案里另一只灰狸花却是 gray —— 于是花色「一致」，
# 把 0.670 的错猫顶到了 0.687 的对猫前面。8 张里踩了 2 张。
# 结论：只有属性来自 **CLIP / 远程 API**（`/health` 的 attrSource=clip|api）时，
# 这条信号才可信；纯色域启发式不够格否决特征相似度。
# 打开方式：ATTR_RERANK=1，并且只在 attrSource=clip/api 的部署里开。
ATTR_RERANK = _b("ATTR_RERANK", False)
# 只在「分不出来」时才用花色破平：余弦差小于这个值才允许调整名次。
# 这条限制是为了防止花色把一只明显更像的猫挤下去 —— 排名的第一决定权
# 必须留在特征相似度上，花色只能处理它自己也无能为力的平局。
ATTR_TIE_BAND = _f("ATTR_TIE_BAND", 0.02)
# 属性置信度低于它就当没判出来（启发式给 0.45~0.88，0.5 以下是「颜色不集中」）
ATTR_RERANK_MIN_CONF = _f("ATTR_RERANK_MIN_CONF", 0.5)

# 花色**硬过滤**（2026-10-24）：识别明确判出 X 时，与 X「物理不可能」的档案
# 直接从候选里剔除，而不是只降名次。现场：上传黑白奶牛猫，候选第 2/3 名是
# 橘猫（67.3%）和三花猫（65.2%），比第 4 名真·奶牛猫还靠前 —— 用户观感就是
# 「识别坏了，橘猫怎么可能是这只黑白猫」。
# ⚠️ 只敢挡 attrs.HARD_EXCLUSIVE 里的互斥对（黑白系 × 橘/三花/玳瑁）：
#    「档案里有橘色块」与「查询是黑白猫」不能共存，这是存在性级矛盾；
#    软相容表的 False（如 cow vs gray）**不能**拿来过滤 —— 黑白误判成灰/狸花
#    是启发式踩过的坑（见上），硬过滤会把正确档案剔光，比不滤更糟。
# 与 ATTR_RERANK 不同，这条默认**开**：误杀面已被互斥表收窄到历史零误判的方向，
# 而收益（候选里不再出现一眼假的花色）是用户直接可感知的。
# 置信门槛复用 ATTR_RERANK_MIN_CONF：识别判不出花色（conf 不足）时不过滤。
ATTR_FILTER = _b("ATTR_FILTER", True)

# 档案花色未知时的**展示分上限**（2026-10-31）。
# 现场：上传三花猫，候选第一名是「胖橘」——它档案里的 pattern/color 都是空的，
# 硬过滤只能放行；纯余弦 0.574 经 logistic（slope=25）折成 97%，用户看到的就是
# 「很有把握地认错」。花色这一维没能校验时，展示分不该给出这种把握。
#
# 只降分不剔除：空值 ≠ 冲突，档案没填也可能就是同一只猫；封顶后仍高于
# IDENTIFY_MIN(45)，真匹配照样判「认出来了」，只是不再出现 90+ 的假确定。
# 0 = 关闭该上限。只在「查询判出了花色、档案花色为空」时生效 —— 两边都没信息
# 时不存在「缺失证据」这回事，封顶会把整张低置信花色照片的候选全压平。
ATTR_UNKNOWN_CAP = _i("ATTR_UNKNOWN_CAP", 60)

# 判「奶牛猫」的必要条件：gray 桶必须低于它。
# 奶牛猫的物理本质是两块不同色相的毛（V 分布双峰）；而单色猫在光线下的明暗
# 变化会让同一团毛同时贡献 light 和 dark，两色调规则原封不动命中 ——
# 2026-10-26 实测：标准白猫素材 gray=0.45、用户夜间白猫 gray=0.51，都因此
# 误判成「黑白奶牛猫」；真奶牛照 gray 在 0.2 上下。设 0.35 留足中间带。
# 调大的风险：把真奶牛猫放过界判成灰猫；调小则灰白猫又会被判成奶牛。
ATTR_COW_MAX_GRAY = _f("ATTR_COW_MAX_GRAY", 0.35)

# 狸花判定（attrs 规则 7）的必要条件：「暖色系像素」（H 5~55、S≥50，**不限
# 亮度**）至少占画面这么多。狸花的物理本质是「暖色底毛 + 深色条纹」，底毛再暗，
# 色相与饱和度也在（S/H 对亮度天然免疫，V 会随曝光塌掉 —— 所以这项证据不看 V，
# 夜间也能用）。2026-10-26 实测：黑猫标准素材 stripe=0.63 过线，但条纹分全部
# 来自灰色沙发的方向性褶皱，暖色系像素仅 6.8% —— 低于门槛的高条纹分只能来自
# 环境织物纹理，不能给黑猫凭空长出条纹。设 0.10：真狸花底毛远高于此（20%+），
# 黑猫+沙发纹理在 5%~8%。调大的风险：灰狸花（蓝虎斑）底毛偏中性，会被降级成
# gray/tabby（颜色判灰、花纹仍标条纹，可接受）。
ATTR_TABBY_MIN_WARM = _f("ATTR_TABBY_MIN_WARM", 0.10)

# 三花宽松规则（attrs 规则 4）的必要条件：必须有**鲜明橘**（orange 桶）至少
# 这么多。宽松规则原本只看 white+dark+warm，而「浅橘/乳橘猫 + 白墙 + 阴影」
# 的统计和三花一模一样：2026-10-26 实测橘猫标准素材 white=0.285 全来自墙、
# dark=0.31 全来自阴影、warm=0.28 全来自落进 brown 桶的低饱和橘毛，orange 桶
# 只有 0.003 → 判成三花。真三花必有可观鲜明橘块（严格规则门槛 0.08），宽松
# 规则降到 0.05 兜底；低于它的 white+dark+warm 改走规则 5 判橘系 ——「橘白猫」
# 远比「墙根下的橘猫被判三花」接近真相。
# 2026-10-31 抠图后校准为 0.04：抠图把背景墙/阴影剔除后，三花猫2 的鲜明橘
# 只剩 0.05（刚好等于旧门槛，抖动一下就会掉到 0.04x）。真三花必然有橘块，
# 0.04 对橘猫/奶牛/狸花均无风险 —— 它们的 dark/warm/gray 条件各自挡得住。
ATTR_CALICO_MIN_ORANGE = _f("ATTR_CALICO_MIN_ORANGE", 0.04)

# 查询图质量门控：猫在画面里的最小占比。低于它 → 不出候选、花色也弃权。
# 依据是 2026-10-26 的实拍复现（详见 engine._quality 的 docstring）：
# 夜间白猫实拍占比 4.9% 时，与正确档案余弦 61.5%、与错误档案 63.8%（方向反了）；
# 同一只猫按比例缩小做对照，占比 3.2% 仍有 +5.0% 区分度、框退化则全线配错。
# 单纯压暗到 0.4 倍区分度仍有 +17.7%，所以门槛看**占比**而不是亮度。
# 6% ≈ 猫身占画面短边 1/4：手机正常举拍（猫占 15%~50%）不会误伤，
# 只有"站在两三米外随手一拍"会被挡 —— 那种照片本来就认不出来。
QG_MIN_AREA_RATIO = _f("QG_MIN_AREA_RATIO", 0.06)

# 查询图质量门控（第二维）：猫体区域的平均亮度（HSV 的 V，0~255）。
# 低于它 → 与占比门控同后果：不出候选、花色弃权。
#
# 依据是 2026-10-26 深夜的第二例实拍复现（与上面 4.9% 那例**同一天、不同根因**）：
# 夜间白猫近拍（框占画面 47%，占比门控放行），结果花色判「黑猫 0.824」、
# 检索把白天白猫档案排在英短后面（53.7% < 57.5%，**方向反了**），线上给出
# 「胖橘 79.7%」。gamma 亮度增强救不回来（增强后仍排第二）。
# 实测分布（猫体 crop 平均 V）：夜间 105 / 113，白天全部 ≥178（白/橘/灰 8 张）。
# ⚠️ 旧结论「压暗 0.4 倍区分度仍有 +17.7%，门槛不看亮度」只对**模拟压暗**
# 成立；真实夜间照（点光源 + 色偏 + 相机降噪）是另一个分布，必须单独设门槛。
# 125 落在两簇正中间，余量 >50：黄昏/室内灯下的照片（130~170）不受影响。
QG_MIN_LIGHT_MEAN_V = _f("QG_MIN_LIGHT_MEAN_V", 125.0)

# ---------------- 暗光 / 复杂背景 增强（2026-10-28）----------------

# 低光检测重试：第一次没框到猫时，把暗图 gamma 提亮、按 DETECT_RETRY_CONF 再试一次。
# 夜间点光源 / 背景杂乱的照片常整只漏检（对比度低），提亮后 conf 明显回升；
# 提亮不改尺寸，框坐标与原图 1:1。只在首次空手时触发，正常照片零开销。
# ⚠️ 这是「再试一次」的兜底，不是替代正常检测；提亮后仍框不到就退回整图路径。
DETECT_LOWLIGHT_RETRY = _b("DETECT_LOWLIGHT_RETRY", True)
# 重试时的置信阈值：比首试（DETECT_CONF 0.35）低一档，暗图里真猫的 conf 普遍
# 落在 0.2~0.35；再低会开始把背景杂物框进来（框错比框不到更糟 —— crop 错了
# 特征就是随机采样）。
DETECT_RETRY_CONF = _f("DETECT_RETRY_CONF", 0.2)

# 查询端翻转 TTA：单/双帧识别时把 crop 左右镜像再提一次特征，两条向量平均。
# 猫左右不对称，DINOv2 的镜像不变性是软的；平均能抵消单视角噪声，对
# 「同猫另一构图」的边缘样本有稳定的小幅余弦收益 —— 正好补在 IDENTIFY_MIN
# 门槛附近的误判带上。帧数 ≥3 时多帧平均已提供同等的方差缩减，不再加倍耗时。
# ⚠️ 只对查询端开：建库（/v1/index/build）保持单向量 —— 双侧同改要重校
# SIM_MID，而「查询 TTA + 库不 TTA」的不对称是 ReID 常规做法，分布影响可忽略。
QUERY_TTA_FLIP = _b("QUERY_TTA_FLIP", True)

# 单图查询的三视图特征平均（engine.analyze_frames，2026-10-31）：
# 抠图灰底外扩框 + 抠图灰底核心框 + 原始裁剪，三条向量平均。
# 依据是 8 张东南大学原图的实测：只提灰底外扩框时，俯拍/趴卧等与档案构图差异
# 大的照片整体偏移，正确档案 0.364 被玳瑁档案 0.408 压过（Top1 错）；
# 三视图平均后正确档案 0.490、8/8 Top1 全对，其余 7 张排序不变。
# 只在 n==1 生效（视频多帧已有视角多样性，逐帧三视图会把推理次数乘 3）。
QUERY_MULTI_VIEW = _b("QUERY_MULTI_VIEW", True)

# 曝光锚点的眩光防护（attrs._exposure_shift）：V ≥ 此值且 S ≤ ATTR_GLARE_S 的
# 像素视为点光源/强反光，从 p98 锚点统计中剔除（占比过半时放弃剔除）。
# 夜间照片里一盏灯就能把 p98 顶到 240+，让严重欠曝画面误判「曝光正常」，
# 白毛整桶掉进灰/黑（2026-10-26 夜间白猫判「黑猫 0.824」的锚点侧成因）。
ATTR_GLARE_V = _f("ATTR_GLARE_V", 248.0)
ATTR_GLARE_S = _f("ATTR_GLARE_S", 35.0)

# ---- 2026-10-28 棚拍白背景误判的实测修正（18 张东南大学实拍猫图校准）----
# 奶牛规则的暖色闸（V 免疫版）：「狸花/深猫 + 白背景棚拍」会让 white/black 同时
# 够量、统计上与奶牛无法区分；真奶牛猫黑白毛都不含暖色（warmish 实测 0.01~0.09），
# 狸花底毛是暖黄褐（0.37）。超过此值不许判奶牛。None（没证据）时闸门不生效。
# ⚠️ 0.25 → **0.34**（2026-10-31 实测「奶牛猫.jpg」warmish=0.313 被挡成狸花）：
# 该图是黑白奶牛猫在暖色木地板/暖光下拍摄，暖色像素来自环境反射而非猫毛。
# 真狸花底毛实测 0.37~0.60，0.34 仍留 0.03 余量挡得住；玳瑁在更早的规则 2 命中。
ATTR_COW_MAX_WARM = _f("ATTR_COW_MAX_WARM", 0.34)
# 奶牛规则的「棕色上限」（2026-10-31 新增，配合上面暖色闸放宽）：
# 暖色闸从 0.25 放宽到 0.30/0.34 后，**米黄/棕色纯色猫**（乳橘猫趴在白墙旁，
# 实测 brown 0.279、cream 0.014、warm 0.296、light 0.37/dark 0.31）会整条命中
# 奶牛规则（老用例 test_buff_cat_against_wall_is_not_calico 当场变 cow）。
# 区分依据是暖色的**构成**：真奶牛猫的暖色只来自暖光下的白毛（cream 少量，
# brown 实测 0.003~0.076），棕色毛本身（brown）不存在；纯色黄褐猫 brown ≥ 0.25。
ATTR_COW_MAX_BROWN = _f("ATTR_COW_MAX_BROWN", 0.15)
# 三花·白背景稀释救援：白占一半以上时鲜明橘被稀释到 0.02~0.05，正常门槛（0.08/
# 0.05）够不着。降到 0.02 必须同时要求 dark ≥ 0.05（真三花必有黑块），
# 挡住「乳橘猫+白墙+阴影」（orange 0.003、dark 全靠阴影）—— 见 _decide 规则 2b。
ATTR_CALICO_LOOSE_ORANGE = _f("ATTR_CALICO_LOOSE_ORANGE", 0.02)
ATTR_CALICO_LOOSE_DARK = _f("ATTR_CALICO_LOOSE_DARK", 0.05)
# 弱条纹带：stripe 卡在 [0.5, ATTR_STRIPE_MIN) 时，要 warmish ≥ 0.25 才认狸花。
# 真狸花底毛暖色证据 0.3+；条纹虚高的奶牛猫（斑块方向性，实测 0.52）warmish
# 只有 0.01~0.09 进不来。下界不能低：奶牛斑块 stripe 实测最高 0.52。
ATTR_TABBY_WEAK_STRIPE = _f("ATTR_TABBY_WEAK_STRIPE", 0.50)
ATTR_TABBY_WEAK_WARM = _f("ATTR_TABBY_WEAK_WARM", 0.25)
# 橘白规则（_decide 规则5）的黑色桶上限：白背景下真橘白猫的 black 桶很低
# （<0.10，只来自阴影/眼线），超过此值说明有真实黑块 —— 玳瑁/狸花的黑毛
# 被白背景衬托后 black 实测 0.19~0.38，不挡住会被规则 5 抢先判成橘白。
# ⚠️ 用 black 桶而非 dark（black+dgray）：buff/乳橘猫的 dgray 可高达 0.23
# （全是阴影），但 black 只有 0.08 —— 用 dark 会误伤真橘白（2026-10-29）。
ATTR_ORANGE_WHITE_MAX_BLACK = _f("ATTR_ORANGE_WHITE_MAX_BLACK", 0.12)

# 玳瑁 vs 狸花（2026-10-31 抠图后校准）：两者在色域上都是「暗色 + 大量暖色」，
# 旧规则只能靠「有没有规则条纹」区分，但玳瑁的红黑不规则斑块本身也会产生
# 周期性梯度（实测 stripe 0.69），狸花猫1 反而只有 0.56 —— 条纹在两者间不可靠。
# 真正稳定的差异是**暖色的构成**：玳瑁的红棕/奶油块（orange+cream）占暖色总量
# 的比例很高（实测 0.25/0.21），狸花的底毛是棕黄褐（brown 为主，0.07/0.07）。
# 超过此值且暗色够量、几乎无白 → 判玳瑁（见 attrs._decide 规则 2）。
ATTR_TORTOISE_RED_SHARE = _f("ATTR_TORTOISE_RED_SHARE", 0.18)
# 上界：整身暖色**全是**红/奶油（warm_red 接近 1）说明这是米黄/橘的纯色猫，
# 不是「红黑交替」的玳瑁（玳瑁必然还有大量深棕/黑毛，warm_red 实测 0.21~0.25，
# 合成奶油/黑条纹测试图是 1.0）。超过此值判玳瑁的规则不生效。
ATTR_TORTOISE_RED_SHARE_MAX = _f("ATTR_TORTOISE_RED_SHARE_MAX", 0.60)

# 「亮毛像素」的定义（matting.fg_stats / attrs 的 bright 统计）：
# V ≥ ATTR_BRIGHT_V 且 S ≤ ATTR_BRIGHT_S。白猫即便在夜里也满足（实测白猫
# 0.94~0.98、夜间白猫 0.11）；玄猫 0.001~0.002、玳瑁 0.027~0.031、
# 狸花 0.056~0.074 —— 差一个数量级，是夜里唯一可靠的「白毛」证据。
ATTR_BRIGHT_V = _f("ATTR_BRIGHT_V", 170.0)
ATTR_BRIGHT_S = _f("ATTR_BRIGHT_S", 60.0)

# 夜间白猫救援（attrs._decide 规则 8b）：抠图只留猫毛后，夜里欠曝的白毛会
# 整桶掉进 gray/black（white 桶只剩 0.10），但「亮毛占比」仍然显著高于
# 其它花色。bright ≥ 此值且平均饱和度 ≤ ATTR_WHITE_NIGHT_SAT → 判纯白。
# 白猫夜里饱和度很低（实测 27~30）；玄猫的 JPG 彩色噪点反而偏高（68~90）。
ATTR_WHITE_NIGHT_BRIGHT = _f("ATTR_WHITE_NIGHT_BRIGHT", 0.08)
ATTR_WHITE_NIGHT_SAT = _f("ATTR_WHITE_NIGHT_SAT", 45.0)
# 夜间白猫救援的最后一闸：black 桶上限。奶牛猫的**白色大胸+白脸**同样会
# 满足上面的 bright/sat（实测奶牛猫1 bright 0.17、sat 38.6），但它的黑毛
# 占比很高（black 0.70），而夜间白猫几乎全白（实测 0.24~0.25）。
ATTR_WHITE_NIGHT_MAX_BLACK = _f("ATTR_WHITE_NIGHT_MAX_BLACK", 0.40)

# 质量门控的「抠图救援」（engine._quality）：面积/亮度不达标时，若抠图确认
# 猫体本身足够大且前景亮度足够，就不再拦。
# 面积救援：紧绷框最小边 ≥ 此像素（猫在画面里占比小，但原图分辨率够，
# 抠图后主体像素仍然充足）；并要求掩膜覆盖率在 [0.2, 0.9]（太低=没抠到主体，
# 太高=掩膜糊成一片，两种情况都不可信）。
QG_RESCUE_MIN_SIDE = _i("QG_RESCUE_MIN_SIDE", 160)
QG_RESCUE_COVERAGE_MIN = _f("QG_RESCUE_COVERAGE_MIN", 0.20)
QG_RESCUE_COVERAGE_MAX = _f("QG_RESCUE_COVERAGE_MAX", 0.90)

# 多张照片合成「代表向量」时保留的比例。
# 档案里 6 张照片，其中 1 张糊了 / 拍的是另一只猫 / 背景占九成，
# 直接平均会把代表向量拉偏（平均值对离群点没有抵抗力）。做法见 engine.rep_vector。
REP_KEEP = _f("REP_KEEP", 0.7)

# 视图离散度门槛：同一只猫的档案照两两余弦均值低于这个值，就不做内点平均、
# 直接退回 medoid 本身。
#
# 依据（2026-10-25，tools/mv_eval.py 实测，margin = 正确猫分 - 最像错猫分）：
#   档案照近似重复  spread 0.928 → 平均 +0.1886 / medoid +0.1787（平均赢：降噪）
#   档案照取景不同  spread 0.888 → 平均 +0.1821 / medoid +0.1847（medoid 略赢）
#   档案照极端差异  spread 0.801 → 平均 +0.1417 / medoid +0.1484（medoid 赢）
# 交叉点在 0.85~0.89 之间，取 0.88：既保住「档案照很整齐时的降噪收益」，
# 又避免「大头特写 + 远景全身」平均出一个谁都不像的中间脸。
#
# ⚠️ 不是「越像越好」也不是「差异越大越好」—— 是看这批照片到底像不像，
# 所以按实测的离散度自适应，而不是一刀切。
REP_SPREAD_MIN = _f("REP_SPREAD_MIN", 0.88)

FFMPEG = _s("FFMPEG", "ffmpeg")
FFPROBE = _s("FFPROBE", "ffprobe")
MAX_FRAMES = _i("MAX_FRAMES", 8)
FETCH_TIMEOUT = _i("FETCH_TIMEOUT", 15)

# 素材下载大小上限（字节）：历史上 r.content 一次性全量入内存，
# 一个几百 MB 的视频 URL 即可打爆容器内存限额
MAX_IMAGE_BYTES = _i("MAX_IMAGE_BYTES", 10 * 1024 * 1024)
MAX_VIDEO_BYTES = _i("MAX_VIDEO_BYTES", 100 * 1024 * 1024)
# 解码后保留的最长边（像素）。识别链路真正用到的分辨率远小于原图：
# 检测输入 640、ReID 输入 224。手机原图 4000×3000 的 JPEG 解码本身就要
# 200~400ms，之后再缩到 640 等于白解一遍。JPEG 走 libjpeg 的 draft 缩放
# （按 1/2、1/4、1/8 直接低分辨率解码）+ 解码后兜底缩边，这一步通常能省一半以上。
# 设为 0 关闭（退回「原分辨率解码」）。
FETCH_MAX_SIDE = _i("FETCH_MAX_SIDE", 1024)

# 云函数没传 thumbUrl 时（例如云函数侧还没更新），服务端自己给云存储图片
# 拼 COS 图片处理参数做缩略图，避免退化成下载原图。只对已知 COS/云存储域名生效，
# 其它域名（含自建图床）一律不动 —— 拼错参数会拿到 400，虽然能回退原图，
# 但白跑一次失败请求。设为 0 关闭。
DERIVE_THUMB = _b("DERIVE_THUMB", True)
# 拼出来的缩略图边长：ReID 输入 224、检测 640，768 足够且体积只有原图零头
DERIVE_THUMB_SIZE = _i("DERIVE_THUMB_SIZE", 768)
# 缩略图强制走 JPEG。现场云托管日志：.png 上传的 768px 缩略图下载 902ms，
# 转 JPEG 后体积通常只有 1/10 —— 这是「服务端 1977ms 卡在轮询窗口外」的主因。
THUMB_JPEG = _b("THUMB_JPEG", True)

# 识别热路径补库时，单张照片的下载超时上限（秒）。补库是顺手做的，
# 不能因为一张慢图吃掉云函数给 AI 的 1800ms 窗口 —— 没补完下次接着补。
BOOTSTRAP_FETCH_TIMEOUT = _f("BOOTSTRAP_FETCH_TIMEOUT", 1.5)

# ---------------- 识别结果缓存 ----------------
#
# 视频识别服务端约 3.5s，而云函数 poll 路径只能给 AI 1.8s（客户端 3s 硬预算决定）。
# 窗口注定算不完，于是每一轮从头再算、结果全丢，重试耗尽后降级本地引擎
# —— 现场日志里同一个视频一分钟被算了 10 次，最后一次都没用上。
# 解法不是放大窗口（做不到），而是**让第二次调用直接拿到第一次的结果**：
# poll#1 触发计算（自己超时放弃但服务端跑完并缓存）→ poll#2 命中缓存秒回。
#
# ⚠️ 进程内缓存，只在**单实例**下有效；云托管必须锁最大实例数=1
#    （与 INDEX_BACKEND=cos 的约束相同）。多实例时缓存命中率退化，
#    但结果依然正确 —— 只是回到「每轮重算」的老路。
RECO_CACHE_TTL = _i("RECO_CACHE_TTL", 600)
RECO_CACHE_MAX = _i("RECO_CACHE_MAX", 64)

# 是否拒绝「私有地址段」的素材 URL（SSRF 纵深防御）。
# 默认 false：本地/内网部署时 asset-base-url 常是 127.0.0.1，开了会误伤；
# 部署到公网且确认素材都在公网可达地址时，设为 true。
# 云元数据地址（169.254.0.0/16）无论此项都拒绝。
BLOCK_PRIVATE_URLS = _b("BLOCK_PRIVATE_URLS", False)

# ---------------- 猫咪标准照生成（AIGC 文生图）----------------
#
# POST /v1/photo/standard：上传一张猫照 → 自动识别花色 → 生成两组提示词
# → 调用图片生成服务 → 返回两张标准照（xx1 全身站姿 / xx2 正面标准）。
# 实现见 app/standard.py。
#
# 两种后端（IMAGE_GEN_URL 优先，未配置则用 agnes 图片模型）：
#   · agnes（默认，带参考图 i2i）—— 上传的原图会作为参考图发给 agnes，
#     生成结果保持「同一只猫」的毛色/花纹/眼色/脸型/体型，而不是同品种的陌生猫。
#     需要 AGNES_API_KEY（见文件末尾 agnes 段）与 IMAGE_GEN_MODEL。
#   · IMAGE_GEN_URL 是**请求模板**，只能传提示词（无参考图），用于接其它服务商：
#   IMAGE_GEN_URL=https://api.example.com/v1/images/generate?prompt={prompt}&size={image_size}
# 不含占位符时自动追加 ?prompt=...&image_size=...（方便接简单的 GET 接口）。
# 两种都没配置 = 未配置：接口返回 503，**不会**用本地拼图伪装成 AI 生成结果。
IMAGE_GEN_URL = _s("IMAGE_GEN_URL")
# 可选 Bearer Token（仅 IMAGE_GEN_URL 模板用）。也可以把 key 直接写进 URL 模板。
IMAGE_GEN_TOKEN = _s("IMAGE_GEN_TOKEN")
# agnes 图片模型：agnes-image-2.1-flash 在 /images/generations 里带 image 字段
# （原图 data URI）时走 i2i 队列，实测生成的猫与参考图一致。
IMAGE_GEN_MODEL = _s("IMAGE_GEN_MODEL", "agnes-image-2.1-flash")
# 单张生成超时（秒）。文生图常 10~60s，一次请求要生成两张。
IMAGE_GEN_TIMEOUT = _i("IMAGE_GEN_TIMEOUT", 120)
# 生图服务返回图片 URL 时的下载上限（字节）。
IMAGE_GEN_MAX_BYTES = _i("IMAGE_GEN_MAX_BYTES", 20 * 1024 * 1024)
# 两张图的画幅。只接受 "1K/2K/3K/4K" 或 "WIDTHxHEIGHT"；landscape_4_3 / square_hd
# 这类命名会被 agnes 400 拒绝（实测）。
IMAGE_GEN_SIZE_FULL = _s("IMAGE_GEN_SIZE_FULL", "2048x1536")
IMAGE_GEN_SIZE_FRONT = _s("IMAGE_GEN_SIZE_FRONT", "2048x2048")
# 可选：结果落盘目录。留空只返回 base64；请求里 save=true 时需要配置它。
IMAGE_GEN_DIR = _s("IMAGE_GEN_DIR")

# ---------------- agnes 大模型（兼容 OpenAI Chat Completions 格式）----------------
#
# 一个外部对话大模型，端点兼容 OpenAI 的 /chat/completions 协议：
#   完整 URL = AGNES_API_BASE + "/chat/completions"
# 「OpenAI Chat Completions 格式」意味着它吃标准 messages（role/content），
# 支持多模态（content 为 image_url + text 的 parts 数组）。
# 详见 app/agnes.py 的封装与 main.py 的 /v1/agnes/chat 路由。
#
# ⚠️ AGNES_API_KEY 留空 = 接口不可用（每次调用会返回明确的「未配置」错误，
#    不会把空 key 发给远端）。由部署方在环境变量 / .env 里填写。
AGNES_API_BASE = _s("AGNES_API_BASE", "https://api.agnes-ai.cn/v1")
AGNES_API_KEY = _s("AGNES_API_KEY","sk-EkNdiBbtix9A9Wim2pOxsold9rAaoDX208U73Bn9mb8jT62O")
AGNES_MODEL = _s("AGNES_MODEL", "agnes-2.5-flash")
AGNES_TIMEOUT = _i("AGNES_TIMEOUT", 30)

# ImageNet 归一化常量（DINOv2 / CLIP 都用这一组）
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)

# CLIP zero-shot 用的毛色 / 花纹标签（中文回写给前端，英文送给模型）
COLOR_LABELS = {
    "橘猫": "a ginger orange cat",
    "狸花": "a brown tabby cat with stripes",
    "黑白": "a black and white tuxedo cat",
    "纯白": "a solid white cat",
    "纯黑": "a solid black cat",
    "灰色": "a gray blue cat",
    "三花": "a calico tortoiseshell cat",
    "玳瑁": "a tortoiseshell brindle cat",
    "重点色": "a siamese pointed cream cat",
}
PATTERN_LABELS = {
    "tabby": "a tabby striped cat",
    "solid": "a solid color cat with no pattern",
    "cow": "a bicolor black and white cow cat",
    "calico": "a calico patched cat",
    "pointed": "a pointed colorpoint cat",
    "spotted": "a spotted cat",
}
