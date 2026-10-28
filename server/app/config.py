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
# 特征算法版本：池化策略等变更时递增。写进 COS 对象头（1 字节），
# 读取时版本不符的对象直接跳过 —— 防止换算法后新旧向量（同维不同义）混算乱匹配。
FEATURE_POOL_VERSION = _i("FEATURE_POOL_VERSION", 2)   # v1=mean-pool, v2=CLS
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

# 条纹显著度门槛（0~1）。低于它判 solid。
# 0.60 是频率法实测标定的分界（8 张真实猫照）：
#   真条纹（狸花）带数 11+ / 调制 0.63+ → 得分 0.9+；
#   黑白斑块（奶牛）的边界只有 1~3 条交替带 → 得分 ≤0.55；
#   纯色 → 0。旧阈值 0.35 会把奶牛斑块误判成虎斑。
ATTR_STRIPE_MIN = _f("ATTR_STRIPE_MIN", 0.60)

# 有效"猫色"像素占画面的最低比例。低于它说明猫太小 / 背景太杂，
# 此时**返回空而不是硬编一个颜色** —— 伪造属性比没有属性危害大。
ATTR_MIN_COVERAGE = _f("ATTR_MIN_COVERAGE", 0.22)

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
# 0.62 的依据：无关图上限 0.55，留 0.07 余量；而「同猫不同构图」的下沿约 0.74，
# 中间这段全是边缘候选。老值 0.67 是配线性窗口定的 —— 现在分数由 logistic 给出，
# 低分候选自己就会显示成个位数，「宁可多给一条候选让人看一眼」比
# 「真猫被挡在门外」好：挡掉的是**可见的选项**，留下的只是一行低分。
MIN_SIM = _f("MIN_SIM", 0.62)

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
# SIM_MID=0.755：同猫不同构图的下沿，也是异猫上沿的中间带；
# SIM_SLOPE=30：在 0.70~0.85 给出接近线性的响应，两端饱和。
# 参照点（可据此反推线上表现）：0.62→1 / 0.70→16 / 0.74→39 / 0.763→56 /
#                              0.80→79 / 0.85→94 / 0.90→98
SIM_MID = _f("SIM_MID", 0.755)
SIM_SLOPE = _f("SIM_SLOPE", 30.0)
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
ATTR_CALICO_MIN_ORANGE = _f("ATTR_CALICO_MIN_ORANGE", 0.05)

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
