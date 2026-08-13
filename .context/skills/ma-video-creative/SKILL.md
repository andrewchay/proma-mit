---
name: ma-video-creative
description: 共享素材 | 视频生成 Agent 入口。引导 Agent 调用领域工作台「共享素材」子域的视频生成能力（creative-video-service）：分镜生成 → （可选）视频成片流水线 → 元数据探测。分镜为纯本地生成无需凭据；成片需视频引擎凭据。供达人(influencer)与广告投放(paid-media)两端复用。当用户提到"视频素材"、"分镜"、"广告视频"、"成片"、"共享素材"时触发。
version: 1.1.0
tags:
  - marketing
  - creative
  - shared-assets
  - video
  - storyboard
---

# MA Video Creative — 共享素材 · 视频生成 Agent 入口

## 定位

本 Skill 是**领域工作台「共享素材」（creative 子域）的视频生成能力入口**，引导 Agent 通过对话调用底层 `creative-video-service` 提供的视频生成能力。

- 共享素材层（creative）为 **shared kind**，被达人 influencer 与广告投放 paid-media 两个业务包内嵌复用（`dependsOn: [creative]`）。
- 产物统一落盘到 `{assetsRoot}/video-assets/` 下的 `raw/`（分镜片段）、`final/`（成片）、`frames/`（首帧图）。
- **不是独立领域 skill**，而是共享素材能力对 Agent 的调用入口。

## 能力清单（对应 creativeVideoService）

| 能力 | 方法 | 依赖 | 是否可用 |
|------|------|------|---------|
| 分镜生成 | `generateCreativeStoryboard` | 无（纯本地模板+规则） | ✅ 开箱即用 |
| 视频成片流水线 | `runCreativeVideoPipeline` | 引擎凭据（**优先「模型配置页」渠道**：Seedance→doubao 渠道、MiniMax H3→minimax 渠道；未配置渠道时回退环境变量 `VOLCENGINE_API_KEY` / `MINIMAX_API_KEY`） | ⚠️ 需凭据 |
| 首帧图 | `frame-generator` | Proma Cloud `PROMA_CLOUD_API_KEY` + `PROMA_CLOUD_BASE_URL` | ⚠️ 需凭据，无则回退文生视频 |
| 元数据探测 | `probeVideoAsset` | ffprobe | ✅ 已装 |
| 凭据校验 | `creativeVideoService.checkCredential` | — | ✅ |

## 执行流程

### 第 1 步：收集输入

| 参数 | 必填 | 说明 |
|------|------|------|
| brand | ✅ | 品牌名称 |
| product | ✅ | 产品/服务名称 |
| category | ❌ | 品类（护肤品/彩妆/食品/服装/3C/通用） |
| selling_points | ❌ | 核心卖点，3-5 个 |
| target_audience | ✅ | 目标人群 |
| platform | ✅ | xiaohongshu / douyin / bilibili / weibo |
| duration | ❌ | 成片时长（秒），默认 15，受平台上限限制 |

### 第 2 步：生成分镜（纯本地，必做）

调用 `generateCreativeStoryboard(input)`，产出 `Storyboard`：
- 15s 模板（3 镜：Hook → 产品 → CTA）或 30s 模板（5 镜：Hook → 痛点 → 产品 → 证明 → CTA）
- 每镜含：画面描述、镜头运动、旁白、字幕、首帧提示词 `firstFramePrompt`、视频提示词 `videoPrompt`、转场

**平台适配**：小红书 3:4 / 抖音 9:16 / B站 16:9 / 微博 1:1。

### 第 3 步：判断成片条件

调用 `creativeVideoService.checkCredential(engine)` 校验引擎凭据（返回 `{ ok, source, channelId, channelName }`）：

- **凭据来源**：`source === 'channel'` 表示命中「模型配置页」渠道（Seedance→doubao、MiniMax H3→minimax），`source === 'env'` 表示回退环境变量。
- **有凭据** → 调 `runCreativeVideoPipeline({ assetsRoot, storyboard, aspectRatio, engine, engineChannelId?, ... })`，产物落盘 `video-assets/{raw,final,frames}`；`engineChannelId` 可显式指定渠道（缺省自动选首个可用渠道）
- **无凭据** → **不强行生成**，明确告知用户：
  - 分镜已生成可用；成片需配置视频引擎凭据（在「模型配置页」添加 doubao / minimax 渠道，或设置环境变量 `VOLCENGINE_API_KEY` / `MINIMAX_API_KEY`）

### 第 4 步：产物落盘与呈现

- 将分镜脚本保存为 `video-assets/storyboard.{json,md}`
- 成片成功后用 `probeVideoAsset` 读取时长/分辨率/码率呈现给用户
- 视频产物通过共享素材资产表（`creative_asset`，media='video'）登记，供两端复用

## 分镜模板速查（来自 storyboard-engine）

### 平台配置

| 平台 | 分辨率 | 推荐时长 | 最大时长 | 风格 |
|------|--------|---------|---------|------|
| 小红书 | 1080x1440 | 15s | 60s | 真实感、种草感、软植入 |
| 抖音 | 1080x1920 | 15s | 60s | 快节奏、强Hook、音乐驱动 |
| B站 | 1920x1080 | 30s | 120s | 内容深度、知识性 |
| 微博 | 1080x1080 | 15s | 30s | 话题性、精致、社交传播 |

### Hook 文案（按品类）

| 品类 | hook 话术 |
|------|----------|
| 护肤品 | 熬夜后皮肤状态差？ |
| 彩妆 | 脱妆尴尬？ |
| 食品 | 下午3点又饿了？ |
| 服装 | 明天穿什么？ |
| 通用 | 还在用老方法？ |

### CTA 文案（按平台）

| 平台 | CTA |
|------|-----|
| 小红书 | 点击左下角，get同款 |
| 抖音 | 点击小黄车，立即下单 |
| B站 | 一键三连，评论区见 |
| 微博 | 转发抽奖，福利多多 |

## 输出格式

分镜脚本建议提供 Markdown 可读版 + JSON 提示词版：

```markdown
# {品牌} · {产品} — {平台} 广告视频创作包
- 总时长：{total}s | 分镜数：{count} | 宽高比：{aspect}

### 镜 01 · {场景}（{start}-{end}s）· {duration}s
- 画面：{visual_description}  | 镜头运动：{camera}
- 旁白：{narration}  | 字幕：{subtitle}  | 转场：{transition}
- 首帧提示词：{first_frame_prompt}
- 视频生成提示词：{video_prompt}
...
```

## 规则

1. **分镜始终可生成**：storyboard-engine 纯本地，无需任何凭据/LLM/API。
2. **成片不强行**：引擎凭据未配置时明确告知，不虚假声称已生成成片。
3. **不虚构卖点**：品牌信息不足时标注需补充项。
4. **引擎无关的分镜/提示词**：分镜产出的是通用视觉描述，后续可对接任意视频引擎（不局限于 Seedance/MiniMax）。
5. **归于共享素材**：产物归入共享素材（creative 子域），供达人/投放两端复用，而非某个独立领域。

## 与相关组件的关系

| 组件 | 角色 |
|------|------|
| `CreativeVideoPanel.tsx` | 共享素材的 UI 视频生成面板 |
| `creative-video-service.ts` | 主进程能力封装（本 Skill 引导 Agent 调用的对象） |
| `marketing/video/` | storyboard / 引擎 / 合成 / 首帧的纯逻辑实现 |
| `creative_asset` 表 | 素材成品登记（media: image/video） |
| `ma-script-studio` skill | 面向达人实拍的脚本/分镜（真人出镜方向，与 AI/合成视频互补） |
