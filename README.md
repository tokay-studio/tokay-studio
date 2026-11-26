# TOKAY 图生衣工作台 · 系统骨架

面料图 → AI 模特成衣展示图 的批量生成系统。零依赖（Node >= 18，无需 npm install）。

## 快速启动

```bash
node server.js
# 打开 http://localhost:3199
```

首次使用：右上角「⚙ 设置」填入图像生成 API Key（存于服务端 config.json，浏览器不可见）。

## 目录结构

```
tokay-studio/
├── server.js          # 服务端：固化 Prompt 模板 + 生成适配器 + 任务队列 + 文件服务
├── public/
│   └── index.html     # 单页前端：上传 → 选参数 → 进度轮询 → 结果下载 + 历史
├── uploads/           # 上传的面料图（运行时生成）
├── results/           # 生成结果图（运行时生成）
├── config.json        # API 配置（运行时生成；含密钥，切勿外传）
└── tasks.json         # 任务记录（运行时生成，保留最近 200 条）
```

## 核心设计（保证"任何账号生成风格一致"）

1. **Prompt 模板固化在服务端**（server.js 顶部的 `STYLE_MAP` / `SCENE_MAP` / `LOOK_MAP` / `MODEL_DESC` / `buildPrompt`）。前端只传变量参数（款式/场景/风格/头巾/数量），改不了指令骨架。
2. **API Key 只存服务端** config.json，`GET /api/settings` 只返回掩码。
3. **任务异步 + 轮询**：`POST /api/generate` 立即返回 taskId，后台逐张生成，前端 `GET /api/task/:id` 轮询进度。

## 八项 Prompt 公式（出图质量的来源）

面料特征显式描述 + 款式细节 + 模特描述 + 头巾(可选) + 风格效果(可选) + 场景 + 摄影要求 + 负向约束(不改花型/无水印)。
新增风格效果时，在 `LOOK_MAP` 里加一条描述即可（示例：aso-ebi 尼日利亚传统盛典风会自动追加披肩+gele 头巾描述并强制戴头巾）。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/settings` | 读配置（Key 掩码）/ 写配置 |
| POST | `/api/upload` | 上传面料图（JSON dataUrl，png/jpg/webp，≤15MB） |
| POST | `/api/generate` | 提交批量生成任务（count 1–8），返回 taskId |
| GET | `/api/task/:id` | 任务详情（status/progress/results/errors/prompt） |
| GET | `/api/tasks` | 最近 30 条任务 |
| GET | `/files/uploads/*` `/files/results/*` | 图片静态服务 |

## 生成适配器（PROVIDERS）

统一接口 `fn(cfg, imageBase64, mimeType, prompt) -> [{url}|{base64}]`：

- `dashscope`：阿里百炼 qwen-image-edit（同步响应 + 异步 task_id 轮询都支持）
- `openai_chat`：任意 OpenAI 兼容 chat 接口，自动解析 markdown 图片 / images 数组 / data URI 返回（可接 Gemini nano-banana 等中转）

新增服务商：在 `PROVIDERS` 里加一个同签名函数即可。

## 已验证的结果下载

结果 URL 若为 http(s) 会自动下载到 results/ 落盘；data URI / base64 直接写文件。前端每张图带独立下载按钮。

## 二期规划（未实现）

- 账号登录 + 按账号额度计费（可接 WorkBuddy 云服务：Auth + Database + Storage）
- 发布上线（sites 部署，Node HTTP 应用可直接托管）
- 更多方向复用同一骨架：换色 / 花型裂变 / 图生视频（换 PROVIDERS + 换模板即可）
