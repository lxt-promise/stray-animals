# 喵园 CatCampus · Web 版

与微信小程序同源的校园流浪猫管理平台，前端 Vue 3 + 后端 Spring Boot 3。**默认内置 H2 数据库，`mvn spring-boot:run` 直接就能跑**，无需先装 MySQL。

## 技术栈

| 层   | 选型                                                                 |
| --- | ------------------------------------------------------------------ |
| 前端  | Vue 3 + Vite 5 + Vue Router 4 + Pinia + Element Plus + Leaflet（地图） |
| 后端  | Spring Boot 3.2 + Spring Data JPA + spring-security-crypto（BCrypt） |
| 数据库 | H2（默认，文件落 `backend/data/`）/ MySQL（切 profile）                       |
| 鉴权  | 自实现 HS256 JWT（无 jjwt 依赖，避免版本冲突）                                    |

## 启动

```bash
# 1) 后端（8080）
cd web/backend
mvn spring-boot:run

# 2) 前端（5173，已配 /api 代理到 8080）
cd web/frontend
npm install
npm run dev
```

打开 <http://localhost:5173> —— **第一个注册的用户自动成为管理员**。

## 识别测试台（/vision）

上传猫照 → 调用 `server/` 里的识别模型 → 展示候选与相似度。**内部调试工具，不属于面向用户的功能。**

```
浏览器(5173) ──▶ Spring Boot(8080) /api/vision/* ──▶ 识别服务(8090) /v1/*
                    ├─ 代转请求（避免跨域 + token 暴露在浏览器）
                    ├─ 上传的图片落 ./uploads，再把绝对 URL 交给识别服务下载
                    └─ /api/vision/build-index 把猫档案库同步成特征库
```

**完整启动顺序**（三个都要起）：

```bash
# 1) 识别服务（8090）—— 见 docs/本地部署运行手册.md
cd server && ..\env\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8090

# 2) 后端（8080）—— 必须显式指定端口，否则会随机挑端口
cd web/backend && mvn spring-boot:run '-Dspring-boot.run.arguments=--server.port=8080'

# 3) 前端（5173）
cd web/frontend && npm run dev
```

然后访问 <http://localhost:5173/vision>。页面会自动探测识别服务状态；
特征库为空时先点右上角「同步特征库」（要求猫档案里有照片）。

**识别服务没启动时**：页面正常渲染，但徽标显示「识别服务未连接」，
识别按钮会报「调用识别服务失败」——这是预期行为，不是 bug。

相关配置在 `backend/src/main/resources/application.yml` 的 `catcampus.vision.*`：
`base-url`（识别服务地址）、`token`（须与 server/.env 的 API_TOKEN 一致）、`school-id`。

## 目录结构

```
web/
├── backend/
│   ├── pom.xml
│   └── src/main/java/com/catcampus/
│       ├── CatCampusApplication.java
│       ├── common/          Result / BizException / GlobalExceptionHandler / JwtUtil / CurrentUser
│       ├── config/          WebConfig（CORS + 静态资源）/ JwtInterceptor
│       ├── controller/      Auth Cat Sighting Tnr Task Fund School User Stat File Vision
│       ├── service/         业务层 + FileService（上传）+ VisionService（识别代理）
│       ├── entity/          User School Cat Sighting TnrRecord TaskItem Fund Apply
│       ├── repository/      8 个 JPA Repository
│       ├── service/         User Cat Sighting Tnr Task Fund School Stat File
│       └── controller/      Auth Cat Sighting Tnr Task Fund User School Stat File
│   └── src/main/resources/application.yml
└── frontend/
    ├── vite.config.js
    └── src/
        ├── api/             统一 axios 封装
        ├── router/          含权限守卫（auth / member）
        ├── stores/user.js   Pinia 用户态
        ├── utils/dict.js    枚举（与小程序一致）
        ├── components/      CatCard
        └── views/           Home Cats CatDetail CatEdit Map Sighting
                             Workbench Tnr Task Fund Member Mine Login
```

## 接口一览

| 方法       | 路径                                           | 权限           |
| -------- | -------------------------------------------- | ------------ |
| POST     | `/api/auth/register` `/api/auth/login`       | 公开           |
| GET      | `/api/auth/me`                               | 登录           |
| GET      | `/api/cats` `/api/cats/{id}` `/api/cats/map` | 公开（成员可见更多信息） |
| POST     | `/api/cats`                                  | 成员           |
| DELETE   | `/api/cats/{id}`                             | 管理员          |
| GET      | `/api/sightings` `/api/sightings/recent`     | 公开           |
| POST     | `/api/sightings`                             | 登录           |
| GET/POST | `/api/tnr` `/api/tnr/summary`                | 成员           |
| GET/POST | `/api/tasks`，POST `/api/tasks/{id}/claim`    | 公开看 / 登录后认领  |
| GET/POST | `/api/funds` `/api/funds/summary`            | 成员           |
| GET      | `/api/users`，POST `/api/users/{id}/role`     | 成员 / 管理员     |
| POST/GET | `/api/applies`，POST `/api/applies/{id}`      | 登录提交 / 管理员审核 |
| GET/POST | `/api/schools`，POST `/api/schools/{id}/bind` | 公开 / 管理员创建   |
| GET      | `/api/stat/overview` `/api/stat/recent`      | 公开           |
| POST     | `/api/upload`（multipart，字段名 `files`）         | 登录           |

## 关键设计

1. **数据按 schoolId 隔离** —— 向外拓展 = 新建一个学校，代码零改动。
2. **隐私分级** —— 非社团成员拿到的幼猫/伤病猫坐标是模糊化的，内部备注与医疗备注直接剔除。
3. **权限三层** —— 白名单接口（拦截器）→ 登录态 → Service 内 `CurrentUser.requireMember/requireAdmin`。
4. **台账与档案联动** —— TNR 状态置为「手术/已放归」时自动把猫档案的绝育状态改成「已绝育」。
5. **积分只奖励记录** —— 打卡 +10 / 新猫 +30 / 首遇 +20 / TNR +50，日上限 60；绝不给「投喂」加分。

## 切换 MySQL

```bash
mvn spring-boot:run -Dspring-boot.run.profiles=mysql
# 或：java -jar target/catcampus-backend-1.0.0.jar --spring.profiles.active=mysql
```

先建库：`CREATE DATABASE catcampus DEFAULT CHARSET utf8mb4;`（表结构由 JPA 自动生成）。

生产环境记得改 `application.yml` 里的 `catcampus.jwt-secret`。

## 与小程序版的关系

两者是同一套产品逻辑的两个端：小程序走微信云开发（`E:\Agent\project\stray-animals\miniprogram` + `cloudfunctions`），Web 版走自建后端。数据模型字段一一对应，未来可共用同一个数据库。
