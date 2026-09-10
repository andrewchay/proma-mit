# 达人互暖排查手册（ma-kol-scraper 阶段9）

> 用途：在营销活动选 KOC 达人时，对筛选跑完全流程后输出的 CSV 名单，通过小红书站内评论区交叉分析识别"互暖群"成员，排除虚假互动数据。
> 来源：互暖检测逻辑移植自 MediaCrawler 的 `tools/koc_detect.py` / `store/xhs`，schema 与 MediaCrawler 一致。
> 最后更新：2026-08-23

---

## 一、核心思路

**互暖的本质破绽：真实粉丝是分散随机的，互暖是集中且重复的。**

互暖群通常是**同领域小 KOC 互相评论背书**（相互"暖"），因此识别靠两条核心信号：
1. **跨达人重复**：同一 user_id 出现在多个候选达人评论区
2. **评论者自身是 KOC**：高频评论者的主页也是同领域小博主（粉丝量级与达人对等）

---

## 二、评分逻辑

### 互暖风险分（0-100）

```
互暖风险分 = 60% × 第一层(评论者重合) + 30% × 黑名单命中 + 10% × 第二层(KOC画像)
```

| 层级 | 指标 | 计算方式 | 权重 |
|---|---|---|---|
| **第一层** | 嫌疑占比 | 出现在 ≥ 2 个达人评论区的用户数 / 该达人总评论者数；`占比/15%` 映射到 0-100 分 | 60% |
| **黑名单命中** | 历史互暖号命中 | 评论区中命中黑名单的评论者人数，`命中数/5` 映射到 0-100 分（单达人检测也生效） | 30% |
| **第二层** | KOC 画像 | 嫌疑号中"主页有笔记（同领域博主）"的比例 × 置信度因子 `min(嫌疑号数/5, 1)` | 10% |

> 黑名单为**双文件存储**（默认版 + 本地累积版）：
> - `blacklist.json`（skill 目录）= **出厂默认基线**，随 skill 版本分发，只读，不在此累积
> - `~/.mapro/koc-blacklist.json`（本地）= **累积版**，每次检测把新实锤的互暖号合并写回，跨批次持续累积，不被 skill 更新覆盖
> - 评分时**合并两者**取并集命中，形成"检测 → 累积 → 下轮参与评分"的闭环

### 红线否决项（不参与加分，独立一票否决）

```
模板率 > 20%  →  评论区疑似低质水军，直接排除
```

模板率 = 评论区中"归一化后精确重复 + 近似重复（n-gram Jaccard≥0.8）"的评论占比。

### 判定阈值

| 互暖分 | 结论 |
|---|---|
| ≥ 60 | ❌ 排除（互暖高风险） |
| 40 - 60 | ⚠️ 人工复核 |
| < 40 | ✅ 通过（评论区干净） |

---

## 三、数据 Schema（与 MediaCrawler 一致）

`collect_creator_xhs.py` 产出两个 JSONL 文件，字段定义如下（这是互暖检测的数据基础）：

### `creator_contents_YYYY-MM-DD.jsonl`（笔记）

| 字段 | 说明 |
|---|---|
| `note_id` | 笔记 ID |
| `type` | 笔记类型 |
| `title` / `desc` | 标题 / 描述 |
| `time` | 发布时间 |
| `creator_hash` | 创作者匿名哈希（SHA256 截断 16 位，**不存明文 user_id**） |
| `nickname` | 昵称（中间脱敏） |
| `liked_count` / `collected_count` / `comment_count` / `share_count` | 互动数 |
| `note_url` | 笔记链接 |
| `source_keyword` | 来源关键词（creator 模式下为空串） |
| `xsec_token` | 详情访问 token |
| `user_id` | 明文创作者 user_id（skcript 额外补充，用于名单关联） |

### `creator_comments_YYYY-MM-DD.jsonl`（评论）

| 字段 | 说明 |
|---|---|
| `comment_id` | 评论 ID |
| `note_id` | 所属笔记 ID |
| `content` | 评论内容 |
| `creator_hash` | 评论者匿名哈希 |
| `user_id` | **评论者明文 user_id（跨达人重合的依据）** |
| `ip_location` | 评论者 IP 属地 |
| `nickname` | 昵称（中间脱敏） |
| `like_count` | 点赞数 |

---

## 四、使用方法（阶段9）

前置条件：
- 已完成 8 阶段筛选，有最终清洗后 CSV（含达人 userId 列）
- Chrome 已打开远程调试端口（`--remote-debugging-port=9222`）且已登录小红书（www.xiaohongshu.com）
- 已安装 Python 依赖：`pip install playwright httpx tenacity pyhumps xhshow>=0.2.0`

### 4.1 一键编排（推荐）

```bash
python3 scripts/mutual_warm_pipeline.py \
    --csv <最终清洗后.csv> \
    --id-column userId \
    --data-dir <数据目录> \
    --blacklist blacklist.json \
    --cdp-port 9222 \
    --output 互暖排查结果.csv
```

> 默认会把检测结果累积写入 `~/.mapro/koc-blacklist.json`；想改路径用 `--user-blacklist`。

它会自动完成：提取候选人 → 站内采集笔记+评论 → 三大层互暖检测 → 把互暖分/模板率/结论合并写回 CSV。

### 4.2 分步执行（需要人工介入时）

**步骤1：关联达人 ID（蒲公英 userId → 站内 user_id）**
- 蒲公英筛选出的 userId 是蒲公英内部 id，不一定等于站内 user_id（24 位 hex）
- 蒲公英 blogger 详情页可复制"小红书号"，将其整理成映射文件传给 `--id-mapping`
- 映射文件格式：CSV（两列 `蒲公英id,站内id`）或 JSON（`{"蒲公英id": "站内id"}`）

**步骤2：采集**
```bash
python3 scripts/collect_creator_xhs.py --cdp-port 9222 \
    --user-id <站内user_id1> --user-id <站内user_id2> \
    --max-notes 10 --max-comments 25 --output-dir <数据目录>
```

**步骤3：第一轮检测（出嫌疑名单）**
```bash
python3 scripts/koc_detect.py --data-dir <数据目录> \
    --blacklist blacklist.json --blacklist-user ~/.mapro/koc-blacklist.json \
    <站内id1> <站内id2> ...
```

**步骤4：补抓嫌疑号主页（第二层画像）**
```bash
python3 scripts/collect_creator_xhs.py --cdp-port 9222 \
    --user-id <嫌疑user_id> --skip-comments --max-notes 5 --output-dir <数据目录>
```

**步骤5：重跑检测出最终评分**
```bash
python3 scripts/koc_detect.py --data-dir <数据目录> \
    --blacklist blacklist.json --blacklist-user ~/.mapro/koc-blacklist.json \
    <站内id1> <站内id2> ...
```
（每轮自动把新实锤的互暖号累积写入 `~/.mapro/koc-blacklist.json`；未给 `--blacklist-user` 时降级为单文件读写 `--blacklist`）

---

## 五、互暖群黑名单（截至 2026-08-23，共 17 人）

> 以下 user_id 均出现在 ≥ 2 个不同达人的评论区，且画像验证实锤（主页为同领域 KOC 内容）。未实锤的嫌疑号不进黑名单，避免误伤真实粉丝。

核心成员（跨批次出现的强嫌疑）：`57562d1c`、`68df4512`

完整名单见 Skill 根目录 `blacklist.json`（出厂默认基线，随版本分发）；每次检测新增的实锤号累积在 `~/.mapro/koc-blacklist.json`（本地累积版）。

---

## 六、实测参考（截至 2026-08-23，7 个候选达人）

| 候选达人 user_id | 嫌疑占比 | 黑名单命中 | 互暖分 | 结论 |
|---|---|---|---|---|
| `5659bc1acb35fb1fc97ce0d3` | 1.6% | 2 人 | 22.2 | ✅ 通过（推荐） |
| `6576364e0000000019012212` | 3.0% | 2 人 | 27.9 | ✅ 通过（推荐） |
| `54fec184d39ea2188447a1bc` | 5.9% | 5 人 | 61.5 | ❌ 排除（互暖） |
| `5f9fb5af000000000101e308` | 8.1% | 7 人 | 71.1 | ❌ 排除（互暖） |
| `566e55a07c5bb8166bb0d979` | 10.3% | 8 人 | 81.0 | ❌ 排除（互暖） |
| `57ad4c3b50c4b46d6248049c` | 11.8% | 8 人 | 87.1 | ❌ 排除（互暖） |
| `58c79ce382ec39018842c22c` | 12.3% | 9 人 | 89.3 | ❌ 排除（互暖） |

**特征总结：**
- 通过者（<30 分）：嫌疑占比 <3%，评论区以真实路人为主
- 排除者（>60 分）：嫌疑占比 8-12%，评论区 10%+ 由互暖 KOC 构成
- 互暖群围绕部分达人聚集，核心成员跨批次反复出现

---

## 七、注意事项

1. **合规**：`user_id` 属于个人信息，仅限本地分析使用，勿公开或用于追踪个人
2. **样本量**：第一层采集默认单达人抓 10 篇笔记、每篇评论上限 25 条（`--max-notes` / `--max-comments` 可调），样本过少时评分置信度下降
3. **对照组**：互暖检测依赖多达人横向对比，单达人检测时第二层（KOC画像）置信度会降低
4. **时效**：小红书 xsec_token 有时效，抓取前需从浏览器获取新鲜主页 URL
5. **风控**：大流量抓取注意控制间隔（`--interval`），优先使用 CDP 模式复用真实登录态
6. **ID 关联**：这一步是蒲公英 userId 与站内 user_id 的桥梁，务必先用映射文件正确关联，否则采集/检测会用错 id

---

## 八、相关文件

| 文件 | 说明 |
|---|---|
| `scripts/mutual_warm_pipeline.py` | 阶段9 编排（推荐入口） |
| `scripts/collect_creator_xhs.py` | 站内笔记+评论采集（移植自 MediaCrawler） |
| `scripts/koc_detect.py` | 互暖检测（三层评分 + 红线条，移植自 MediaCrawler） |
| `blacklist.json` | 互暖黑名单·出厂默认基线（随版本分发，只读） |
| `~/.mapro/koc-blacklist.json` | 互暖黑名单·本地累积版（检测结果累积写入，跨批次增值） |