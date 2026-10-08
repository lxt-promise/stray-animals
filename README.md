# 喵园 CatCampus 🐱

校园流浪猫管理与守护微信小程序。从一所学校开始，向外复制。

> 定位：**轻量、纯软件、零硬件**。做街猫做不了（重硬件进不了校园）、北大图鉴没做完（单校开源工具）的事——把「学生互动」和「社团协作」装进一个小程序。

## 核心功能

| 模块          | 面向   | 说明                                                         |
| ----------- | ---- | ---------------------------------------------------------- |
| 猫谱          | 所有人  | 猫口档案：名字、花色、绝育状态、性格、健康、相册、目击数                               |
| 目击打卡        | 所有人  | 拍照 + 位置 + 健康观察；上报未建档的新猫，待社团核实认领                            |
| 校园猫地图       | 所有人  | 猫咪常驻点位地图；幼猫/病猫点位可设为「仅社团可见」                                 |
| 游戏化         | 所有人  | 猫粮值积分（打卡+10 / 新猫+30 / 首遇+20 / TNR+50，日上限 60）、图鉴收集、毛色稀有度    |
| TNR 台账      | 社团成员 | 抓捕→绝育→放归全流程记录；状态更新自动同步猫档案绝育状态                              |
| 喂猫排班        | 社团成员 | 任务发布、认领、完成                                                 |
| 资金公示        | 社团成员 | 收支记录，可关联具体猫咪                                               |
| 成员管理        | 管理员  | 三级角色（爱猫同学 / 社团成员 / 管理员）+ 入社审核                              |
| **AI 猫脸识别** | 所有人  | 拍照 / 相册 / 短视频 → 猫脸检测 → 特征提取 → 档案库检索，输出 Top 候选与相似度；未匹配可一键建档 |

## UI 预览（无需开发环境）

`preview/index.html` 是**纯静态的可点击原型**：双击即可在浏览器打开，手机外壳内可切换全部页面、  
演示 AI 识别流水线动画。不连任何接口，数据为内置样例。

```
start preview/index.html
```

## 技术栈

- **前端**：微信小程序原生（无框架依赖）
- **后端**：微信云开发（云函数 + 云数据库 + 云存储），零服务器零运维
- **内容安全**：文本 `msgSecCheck`、图片 `imgSecCheck`（云函数侧强制）

## 目录结构

```
stray-animals/
├── project.config.json        # 微信开发者工具配置
├── miniprogram/               # 小程序前端
│   ├── app.js/json/wxss       # 全局入口 + 设计系统（深空科技风）
│   ├── pages/                 # 14 个页面（含 pages/recognize AI 识别）
│   ├── components/cat-card/   # 猫卡片组件
│   ├── utils/                 # 枚举常量 / 工具函数
│   └── images/tab/            # tabBar 图标（scripts/gen_icons.py 生成）
├── preview/index.html         # 可点击 UI 预览（纯静态，双击打开）
├── cloudfunctions/catcampus/  # 后端云函数（单函数 action 分发，26 个 action）
├── web/                       # 同功能的 Web 版（Vue 3 + Spring Boot，管理后台/演示用）
│   ├── backend/               # Spring Boot 3.2 + JPA + H2/MySQL
│   └── frontend/              # Vue 3 + Vite + Element Plus + Leaflet
├── docs/                      # 市场分析 / MVP 方案 / 部署指南
├── scripts/gen_icons.py       # 图标生成脚本
├── scripts/theme-dark.js      # 主题批量改版脚本（浅色 → 深空科技风）
├── scripts/check.js           # 静态校验（JS 语法 / JSON / 页面注册 / action 覆盖）
└── _archive/                  # 归档目录（非主链路，可随时删除）
```

> 说明：小程序端确认采用**微信原生 + 云开发**方案。曾评估过的 uni-app 版本已归档到 `_archive/uniapp-20260922/`，不参与构建，可随时删除。

## 快速开始

见 [docs/部署指南.md](docs/部署指南.md)。三步：

1. 微信开发者工具导入本项目，填入你的 AppID
2. 开通云开发，把环境 ID 填进 `miniprogram/app.js` 的 `ENV_ID`
3. 右键 `cloudfunctions/catcampus` → 上传并部署，数据库创建 8 个集合并设权限

**第一个注册的用户自动成为管理员。**

## 关键设计决策

1. **数据按学校隔离**（schoolId）—— 向外拓展 = 新建一个学校文档，代码零改动。
2. **位置隐私分级** —— 精确坐标、内部备注、医疗信息仅社团可见；非成员拿到的是模糊化坐标。吸取街猫直播定位被虐猫者利用的教训。
3. **所有读写走云函数**，数据库权限「仅管理端可读写」，杜绝客户端越权。
4. **个人主体可上线** —— 无支付、无社区论坛类目依赖；订阅付费需企业主体，架构已预留。
5. **AI 识别接口可插拔** —— 云函数只保证一种返回结构。默认走内置占位引擎；  
   配置环境变量 `AI_ENDPOINT`（+ 可选 `AI_TOKEN`）后自动切换到第三方视觉大模型，**前端零改动**：

```js
// cloudfunctions/catcampus 环境变量
AI_ENDPOINT = https://your-vision-api/recognize
AI_TOKEN    = <Bearer 令牌，可空>

// 请求体   { url, fileId, type, frames, schoolId, cats:[{id,name,pattern,color,photos}] }
// 期望返回 { features:{ tags:[{k,v}] }, candidates:[{ catId, score, reason }] }
```
