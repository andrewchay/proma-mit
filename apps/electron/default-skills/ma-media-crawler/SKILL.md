---
name: ma-media-crawler
description: 多平台自媒体内容采集 Skill。当用户需要采集/爬取/抓取小红书、抖音、B站、微博、贴吧、知乎的帖子/视频详情、评论、创作者主页或关键词搜索结果时触发。本 Skill 优先使用 CDP 复用用户已登录的 Chrome，输出标准化 CSV 到工作区。
version: 0.1.0
---

# ma-media-crawler

多平台自媒体内容采集 Skill，基于 [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) 构建，通过 CDP 协议连接用户真实 Chrome 浏览器完成数据抓取。

## 合规声明

MediaCrawler 及其衍生使用仅供学习与研究目的。使用本 Skill 时你必须遵守：

1. 仅用于个人学习、研究或内部业务分析，不得用于商业大规模抓取。
2. 遵守目标平台用户协议、robots.txt 及反爬策略。
3. 合理控制抓取数量与频率，避免对平台造成运营干扰。
4. 不得抓取、存储或传播隐私、敏感或违法内容。

默认配置已限制单帖评论数为 20、并发数为 1，请不要手动调高以免触发风控。

## 触发场景

用户出现以下任意意图时触发本 Skill：

- “采集/爬取/抓取小红书的帖子/评论”
- “获取抖音/B站/微博/贴吧/知乎的视频/帖子详情”
- “批量导出小红书的笔记数据到 CSV”
- “分析某条小红书笔记的评论”

如果用户只提到“搜索小红书”但没有给出具体帖子/关键词，先询问具体需求。

## 当前能力范围（Phase 1）

本版本优先跑通最小闭环：

| 平台 | 支持任务 | 登录方式 | 输出格式 |
|---|---|---|---|
| 小红书 (xhs) | 指定帖子详情 + 评论 | CDP 复用已登录 Chrome | CSV |

后续版本将逐步扩展：关键词搜索、创作者主页、抖音/B站/微博/贴吧/知乎。

## 使用前置条件

1. 用户已经安装 uv 并可用 `uv run`。
2. 用户已启动 Chrome 远程调试：
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 \
     --user-data-dir=/tmp/chrome-dev-profile
   ```
3. 用户已在该 Chrome 中登录小红书（https://www.xiaohongshu.com）。
4. 本 Skill 的 `MediaCrawler/` 子模块已初始化：
   ```bash
   git submodule update --init --recursive
   ```

## 工作流

### 1. 理解用户需求

确认以下信息：

- **平台**：当前仅支持 `xhs`。
- **任务类型**：当前仅支持 `detail`（指定帖子详情+评论）。
- **帖子标识**：支持纯 note_id（如 `64b95d01000000000c034587`）或完整 URL（会自动提取 note_id）。
- **是否需要评论**：默认开启；如不需要，设置 `enable_get_comments: false`。
- **每帖最大评论数**：默认 20，不建议超过 50。
- **输出文件名**：可由用户指定，默认 `xhs_detail_<timestamp>.csv`。

### 2. 生成或读取配置

调用方应把配置写成工作区下的 JSON 文件，例如：

```json
{
  "platform": "xhs",
  "type": "detail",
  "ids": ["64b95d01000000000c034587"],
  "enable_get_comments": true,
  "max_comments": 20,
  "cdp_port": 9222,
  "output_dir": "<workspace>/workspace-files",
  "output_filename": "xhs_detail_20260824.csv"
}
```

路径中的 `<workspace>` 应替换为当前工作区的实际路径。

### 3. 调用采集脚本

```bash
cd apps/electron/default-skills/ma-media-crawler
python3 scripts/media_crawler_runner.py \
  --config <workspace>/workspace-files/xhs-detail-config.json
```

脚本会：

1. 检查 `MediaCrawler/` 子模块是否存在。
2. 检查 CDP 端口是否可连接。
3. 临时覆盖 `MediaCrawler/config/base_config.py` 中的关键配置。
4. 调用 `uv run main.py --platform xhs --lt cdp --type detail ...`。
5. 将 MediaCrawler 生成的 CSV 移动到用户指定的输出目录。
6. 在 stdout 输出结构化结果 JSON。

### 4. 读取结果并汇报

脚本成功后会输出：

```json
{
  "success": true,
  "record_count": 1,
  "comment_count": 15,
  "output_file": "/Users/.../workspace-files/xhs_detail_20260824.csv",
  "log_file": "/Users/.../workspace-files/ma-media-crawler/run_20260824_113700.log"
}
```

向用户展示：

- 成功抓取的帖子数
- 评论数
- CSV 文件路径
- 是否发生脱敏/匿名化（MediaCrawler 默认会对用户 ID 和昵称做匿名处理）

## 输出文件说明

CSV 文件由 MediaCrawler 直接生成，字段可能包含：

- `note_id`: 帖子 ID
- `type`: 帖子类型（video / normal）
- `title`: 标题
- `desc`: 正文
- `time`: 发布时间
- `liked_count`, `collected_count`, `comment_count`, `share_count`: 互动数据
- `nickname`: 创作者昵称（已脱敏）
- `creator_hash`: 创作者匿名哈希
- `tag_list`: 话题标签
- `note_url`: 帖子链接
- `source_keyword`: 搜索来源关键词
- 评论相关字段：`comment_id`, `create_time`, `content`, `like_count`, `sub_comment_count` 等

## 常见问题

### CDP 连接失败

确保 Chrome 已用 `--remote-debugging-port=9222` 启动，并且没有防火墙/端口占用。也可以尝试：

```bash
lsof -i :9222
```

### 登录态失效

如果 MediaCrawler 提示未登录，请让用户在 CDP Chrome 中重新访问小红书并确认登录态。

### 风控/验证码

- 降低 `max_comments` 和抓取频率。
- 避免短时间内连续抓取多条帖子。
- 如触发滑块验证，可在可视化 Chrome 中手动完成。

### 子模块缺失

如果 `MediaCrawler/` 为空，运行：

```bash
git submodule update --init --recursive
```

## 扩展指南

新增平台/任务时：

1. 更新 `schemas/config.schema.json` 的枚举值。
2. 在 `scripts/media_crawler_runner.py` 的 `_PLATFORM_TYPE_HANDLERS` 中增加对应配置映射。
3. 在 `examples/` 下新增示例配置。
4. 更新本 SKILL.md 的能力矩阵。
