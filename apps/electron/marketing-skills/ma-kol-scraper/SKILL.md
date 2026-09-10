---
name: "ma-kol-scraper"
description: "从蒲公英平台按条件批量采集 KOL 数据并输出 CSV，并内置完整 8 阶段筛选流水线（采集→初筛→删互动<100→top-8采集→沪杭复核+CPM/CPE估算→拆分→CPE硬性过滤→4维度打分→清洗）。支持以某达人为种子的「寻找相似」（kolSimilar）扩量模式：先按昵称搜到种子达人，即可批量拉取其相似达人列表并套用同一套筛选流水线。通过 CDP 连接 Chrome，用通用采集器 kol_collector.py + config JSON 采集，用 scripts/ 流水线脚本筛选打分。也可走可选 LLM 圈选校验（kol_screening.py）。内含阶段9 互暖排查：对筛选跑完全流程后输出的最终 CSV 名单，用 collect_creator_xhs.py（站内采集，xhshow 签名）+ koc_detect.py（三层评分 + 红线条）做评论区互暖（KOC 互暖群）排查，排除虚假互动，输出带互暖分/结论的排查结果 CSV。当用户提到采集/爬虫/蒲公英/KOL 数据/批量导出达人/达人圈选/达人评分卡/筛选打分/寻找相似/相似达人/以某达人为种子/找同类博主/同类达人/lookalike/达人扩量/互暖排查/互暖检测/虚假互动/KOC互暖/评论交叉检测或类似表述时触发。"
version: "2.6.0"
---

# 蒲公英 KOL 采集 + 完整筛选流水线 + 互暖排查（v2.6）

## 设计原则（v2.6 新增互暖排查）

0. **阶段9 互暖排查（v2.6 新增）**：在 8 阶段筛选出最终 CSV 名单后，可对名单做小红书站内互暖排查——用 `collect_creator_xhs.py` 抓评论区，`koc_detect.py` 三层评分（评论者跨达人重合 60% + 黑名单命中 30% + KOC 画像 10%，模板率>20% 一票否决），筛出互暖群成员，避免投放给虚假互动的达人。黑名单**双文件存储**（skill 默认基线只读 + `~/.mapro/koc-blacklist.json` 本地累积），评分合并两者取并集。主流程见 `Step 6`，细节见 `references/koc_detect_guide.md`。
1. **内置完整 8 阶段筛选流水线**：主采集 → 初筛 → 删互动<100 → top-8 采集 → 沪杭复核+CPM/CPE 估算 → 拆分 → CPE 硬性过滤（>50 淘汰） → 4 维度打分+清洗。流水线脚本已随 skill 提供（`scripts/`），Agent 按序执行即可，细节见 `references/pipeline.md`。
2. **严格 a AND b 交叉验证**（v2.3）：内容类目命中 `strict_categories` **且** 主页标签命中 `strict_home_tags` 才通过；纯旅游/纯美妆仅当内容类目不命中任一目标类目才排除。
3. **4 维度确定性打分**（推荐）：CPE(50) + 点赞率(20) + 赞评比(20) + 爆文率(10)，满分 100，可复现；与 LLM 圈选校验（`kol_screening.py`）**二选一，勿混合计分**。
4. 其余沿用 v2.1/v2.2：采集与校验分离、相关帖子抽样、规则配置化、不生成独立脚本、Agent 自动执行、WebBridge 不可用于蒲公英（走 CDP + fetch 签名）、登录检查不阻塞。

## 本 Skill 文件位置

> 路径占位符约定：`<skill>` = 本 Skill 目录（即本文件所在目录）；`<workspace>` = 当前工作区目录（MAPro 会话的 agent-workspaces/{slug}）。

```
<workspace>/skills/ma-kol-scraper/
├── SKILL.md                          ← 本文件（编排总纲）
├── references/pipeline.md            ← 完整流水线细节（筛选条件/打分/易错点/38列表头/命令示例）
├── references/koc_detect_guide.md    ← 互暖排查手册（阶段9：评分逻辑/数据schema/分步命令）
├── blacklist.json                    ← 互暖黑名单·出厂默认基线（随版本分发，只读）
├── scripts/
│   ├── kol_collector.py              ← 通用采集器（v2.3）
│   ├── kol_screening.py              ← 可选 LLM 圈选校验引擎
│   ├── screen_v2.py                  ← 阶段2 初筛（女性占比/篇数/交叉验证/报价/粉丝地域）
│   ├── filter_interact.py            ← 阶段3 删合作互动中位数<100
│   ├── filter_health.py              ← 阶段3 删点赞率不健康（日常笔记口径，默认1.6%~12%）
│   ├── split_coop.py                 ← 生成 coop 子集（合作≥1）
│   ├── top8_extractor.py             ← 阶段4 top-8 采集（点抽屉记曝光/点赞/标题/正文）
│   ├── estimate_cpe_cpm.py           ← 阶段5 沪杭复核 + Tweedie 估算 CPM/CPE
│   ├── split_zero.py                 ← 阶段6 拆分合作0/非0
│   ├── add_ratio_cols.py             ← 加「阅读与点赞占比(=点赞÷阅读)」「赞评比」列
│   ├── filter_cpe.py                 ← 阶段7 CPE 硬性过滤（预估CPE>50 淘汰，打分前）
│   ├── score_kols.py                 ← 阶段8 4 维度打分（满分100）
│   ├── clean_final.py                ← 阶段8 清洗（删非美食/果切）
│   ├── collect_creator_xhs.py        ← 阶段9 站内采集（移植自 MediaCrawler，CDP 登录态 + xhshow 签名 → JSONL）
│   ├── koc_detect.py                 ← 阶段9 互暖检测（三层评分 + 红线条，移植自 MediaCrawler）
│   └── mutual_warm_pipeline.py       ← 阶段9 编排（读清洗后CSV→关联ID→采集→检测→合并结果CSV）
├── screening_rules.json              ← LLM 校验规则配置（价格带/权重/阈值/提示词，品牌已中性化）
├── examples/
│   ├── config-hanghai-food-tandian.json    ← 沪杭·生活美食探店示例（含 v2.3 字段，推荐）
│   ├── config-shanghai-food-tandian.json   ← 上海美食探店示例（宽松口径）
│   ├── config-similar-kol.json             ← 寻找相似模式示例（similar_user_id/similar_word 种子扩量）
│   └── pipeline_similar.sh                 ← 8 阶段流水线命令示例（拆分目录 mkdir -p + 带前缀文件名）
└── references/
    ├── payload.md                    ← 搜索 API payload 参考
    ├── collect_maternal_kol.py       ← 历史参考，勿再使用
    └── scraper_template.py           ← 历史参考，勿再使用
```

产出写入 `<workspace>/workspace-files/`。

## 何时使用

**✅ 合适**
- 用户需要从蒲公英批量采集/导出达人数据
- 用户有筛选需求（城市/粉丝量/报价/关键词/内容类目/主页标签）
- 需要按完整流水线筛选到最终名单（含 CPM/CPE 估算、4 维度打分）
- 需要对筛选后的最终名单做互暖排查（评论区交叉检测，排除互暖群/低质水军）

**❌ 不合适**
- 只需单个 KOL 详情 → 用 `ma-kol-crm`
- 需要投放策略而非数据 → 用 `ma-kol-pyramid`
- Chrome CDP 未启动或蒲公英未登录（需要用户配合前置条件）

## 核心工作流

### Step 0 · 检查 / 启动 Chrome CDP + 登录（前置条件）

1. 检查 CDP：`curl -s --max-time 3 http://127.0.0.1:9222/json/version`
2. 未开启时给用户两条启动路径（Mac）：
   - **A（推荐，隔离配置）**：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome_debug`
   - **B（复用主 Chrome）**：先退出所有 Chrome，再执行同样命令（不带 `--user-data-dir`）
3. 登录 `https://pgy.xiaohongshu.com` 后自检：`python3 <skill>/scripts/kol_collector.py --check --port 9222`，输出 `[OK] CDP 已开启` + `[OK] 蒲公英登录态正常` 才继续。

### Step 1 · 解析筛选参数

- 用户给了完整需求 → 直接解析成 config 字段，向用户复述确认。
- 需求模糊 → 用 `page.evaluate()` 在博主广场页做 DOM 提取（`.d-select` / `.ant-select` / `.d-tabs` / `.d-tag-group`），把可用类目/地域/标签选项列给用户。**不要**用 WebBridgeClick 点筛选项。
- 分批确认：① 产品/品牌、类目、性别、地域 ② 粉丝量、报价、内容标签 ③ 关键词、粉丝画像。

### Step 2 · 写 config JSON（唯一需要新写的文件）

放到 `workspace-files/config_{产品}_{城市}.json`。字段表（v2.3）：

| 字段 | 示例 | 说明 |
|------|------|------|
| `keywords` | `["探店","美食","生活记录","plog","氛围感","职场生活","高级感"]` | 搜索关键词（searchType=1 内容搜索） |
| `gender` | `"女"` | 不限/男/女 |
| `location_cities` | `["杭州","上海"]` | 博主地域 |
| `fans_location_cities` | `[]` | 粉丝地域搜索（搜索 API 不按城市名，留空） |
| `target_cities` | `["杭州","上海"]` | 详情页博主地域过滤 |
| `fans_region_cities` | `["上海","杭州",...12城]` | **粉丝地域允许城市**（详情页粉丝画像 top5 判断） |
| `note_price_lower/upper` | `500 / 20000` | 报价范围（元） |
| `fans_number_lower/upper` | `0 / 5000000` | 粉丝量范围 |
| `max_pages` | `100` | 每关键词最大翻页（实际按 total 翻完即停） |
| `search_column` | `"fansCount"` | 搜索排序字段 |
| `search_sort` | `"asc"` | 排序方向 |
| `skip_drawer_extraction` | `true` | 主采集跳过点抽屉（仅 API 中位数；top8 阶段再点） |
| `active_within_days` | `0` | 0=关闭活跃度过滤 |
| `strict_search` | `true` | **开启严格 a AND b 交叉验证** |
| `strict_categories` | `["美食探店","美食","生活记录","家居家装","家居用品","时尚","穿搭","生活"]` | **内容类目目标集合**（一级+二级合并判断，任一命中即可） |
| `strict_home_tags` | `["互联网打工人","精致宝妈","氛围感","高级感","plog","职场生活","探店","ootd","韩系"]` | **主页标签目标集合**（擅长标签，任一命中即可） |
| `strict_exclude_words` | `["大学生","宠物","搞笑","知识付费","课程","培训","备考","留学"]` | 其他排除词（标签命中即排除） |
| `strict_maternal_words` | `["母婴","育儿","孕产","孕期","带娃","辅食","婴幼儿"]` | 母婴类（主页含 `strict_maternal_pass` 才放行） |
| `strict_maternal_pass` | `"精致宝妈"` | 母婴放行标签 |
| `strict_pure_words` | `["旅游","旅行","出行","美妆"]` | **纯旅游/纯美妆排除词**（内容类目不命中任一 `strict_categories`、命中这些词才排除） |
| `grab_comments` | `false` | 评论明细（可选；确定性打分流程**默认不采集**，留 `false`） |
| `notes_samples_file` | （留空） | 相关帖子抽样输出（可选；确定性打分流程**默认不采集**，留空） |
| `force_redownload_ids` | `[]` | 强制重采 userId（搜索搜不到时按昵称 searchType=2 补采） |
| `similar_user_id` | `"5b6f1a8d5506800001c22fc2"` | **寻找相似模式**：种子达人的 userId。配置后走「寻找相似」而非关键词搜索 |
| `similar_word` | `"Milchstraße"` | 寻找相似模式的种子昵称（供日志/识别用） |
| `output_file` | `workspace-files/xx.csv` | 输出 CSV 绝对路径 |

> **字段参数化**：`keywords`/`gender`/`location_cities`/`fans_location_cities`/`target_cities`/`fans_region_cities`/`note_price_lower/upper`/`fans_number_lower/upper`/`strict_categories`/`strict_home_tags`/`strict_exclude_words`/`strict_maternal_words`/`strict_maternal_pass`/`strict_pure_words` 均按 campaign 在 config JSON 配置（每次 campaign 改 config 即可），勿写死进脚本。相关帖子抽样/评论样本（`sample_note_count`/`relevance_keywords`/`grab_note_text`/`grab_comments`/`notes_samples_file`）在确定性打分流程下**默认不采集**。
> 纯旅游/纯美妆排除：**仅当内容类目不命中任一 `strict_categories`、且命中旅游/美妆类目时排除**。`firstIndustry` 取值需从前端 payload 确认，稳妥用 keyword + strict_categories 过滤。

### Step 2b · 寻找相似模式（以某达人为种子扩量）

> **⚠️ 任务判定（v2.5 防误判）**：当用户说"寻找相似"、"按昵称找相似达人"、"以 XX 达人为种子找同类博主"、"更多操作里的寻找相似"时，**必须一开始就走寻找相似（kolSimilar）模式**，不要准备关键词搜索的 config。config 只需 `similar_user_id` + `similar_word`（+ 筛选参数），**keywords 留空、不配 strict_search / strict_* 字段**——直接照抄 `examples/config-similar-kol.json`。采集器在 similar 模式下会自动强制关闭 strict 搜索。

走**寻找相似（kolSimilar）模式**：把种子达人的 userId 配进 config（`similar_user_id` + `similar_word`），采集器自动改用 `blogger/v2` 的 kolSimilar 通道拉取相似达人列表，再走同样的详情采集 + 完整流水线（阶段2-8）。

**机制**（实测 2026-08-13）：页面"更多操作→寻找相似"实际触发 `POST /api/solar/cooperator/blogger/v2`，trackId 前缀 `kolSimilar_`，payload 携带 `similarUserId` + `similarWord`。返回 `data.total` 即相似达人总数，**分页可拉全量**（pageSize=20）。

**⚠️ 关键验证——筛选参数对 kolSimilar 生效**（API 直测）：`similarUserId`/`similarWord` 之外，gender/location/notePriceLower/Upper 等筛选参数**同样生效**，会压缩 total。务必在 config 中配好筛选，避免采到大量无关达人。

| 筛选组合 | total（Milchstraße 种子实测） |
|---------|------|
| 无筛选 | 979 |
| 博主沪杭 | 446 |
| + 报价500-20000 | 321 |
| + 性别女 | 371 |
| **全（女+沪杭+报价）** | **272** |

> 粉丝地域（`fansLocation`）不能用城市名过滤（返回 0），需靠详情页 `fans_profile` 在阶段2 初筛（`screen_v2.py` 的 `fans_region_cities`）判断。

**config 要点**：
```json
{
  "similar_user_id": "5b6f1a8d5506800001c22fc2",
  "similar_word": "Milchstraße",
  "gender": "女",
  "location_cities": ["上海", "杭州"],
  "note_price_lower": 500,
  "note_price_upper": 20000,
  "search_column": "comprehensiverank",
  "search_sort": "desc"
}
```
完整示例见 `examples/config-similar-kol.json`。采集与后续流水线命令与常规模式完全一致（Step 3 / Step 4）。

### Step 3 · 主采集（Agent 自动运行）

```bash
python3 <skill>/scripts/kol_collector.py --config <workspace>/workspace-files/config_xxx.json
```
- 增量写 CSV，中断不丢；失败按 `[FAIL] CDP 未开启` / `[FAIL] 蒲公英未登录` / `code!=0` 区分处理。
- 详情页较慢，Bash 设足够 timeout（600s+，可分批 `max_kols`）。

### Step 4 · 完整流水线（8 阶段）——采集完成后的核心编排

采集得到采集结果 CSV 后，按 `references/pipeline.md` 的完整细节执行 8 阶段。概览：

| 阶段 | 脚本 | 产出 |
|------|------|------|
| 2 初筛 | `screen_v2.py` | 通过名单（女性≥70%/篇数≥4/交叉验证/粉丝沪杭浙/报价500-20000） |
| 3 健康筛选 | `filter_interact.py`→`filter_health.py` | ①删近30日合作笔记互动中位数<100；②删点赞率<1.6%或>12%（**日常笔记**口径：日常点赞÷日常阅读，与打分/「阅读与点赞占比」列一致；2%~10% 健康区间 ±20% 容差，`--lo/--hi` 可配） |
| 4 top-8采集 | `top8_extractor.py` | top8.json（曝光/点赞/标题/正文，断点续采） |
| 5 沪杭复核+估算 | `estimate_cpe_cpm.py` | 最终结果CSV（31列；**输入=阶段3 健康名单**，勿用阶段2 筛选后名单；top8含沪杭→通过；Tweedie 算 CPM/CPE） |
| 6 拆分 | `split_zero.py` | 合作0 / 合作非0（**文件名带输入前缀** `<目录>/<输入名>_合作笔记非0.csv`；先 `mkdir -p <输出目录>`） |
| 7 CPE硬性过滤 | `filter_cpe.py` | 打分输入CSV（去掉预估CPE>50，硬性条件，`--max-cpe` 可配） |
| 8 打分+清洗 | `add_ratio_cols.py`→`score_kols.py`→`clean_final.py` | 打分名单（38列） |

> **拆分命名约定**：`split_zero.py` 输出 `<目录>/<输入名>_合作笔记非0.csv`（base 前缀，非固定名）——阶段7/8 引用必须带前缀；输出目录脚本已自动创建（v2.5.1），手动先 `mkdir -p`。

> 各阶段**完整筛选条件、4 维度打分规则、14 条易错点、38 列最终表头、命令行示例**全部在 **`references/pipeline.md`**——执行前务必阅读。

> **业务规则参数化**：女性占比（`--female-min`）、沪杭复核城市词（`--city-words`）、清洗目标类目/雷区词（`--categories`/`--guoqie-words`）、报价范围（`--price-lo/hi`）均可按 campaign 配置，勿在脚本里写死业务阈值。

### Step 5 · 两种圈选方式（二选一，勿混合）

1. **4 维度确定性打分（推荐，可复现）**：`score_kols.py`。CPE(50)/点赞率(20)/赞评比(20)/爆文率(10)，满分 100。规则见 `references/pipeline.md` 第 3 节。
2. **LLM 圈选校验（可选，需 LLM + 抽样笔记）**：`kol_screening.py` + `screening_rules.json` 四条规则（风格/价格带/评论画像/CPM·CPE），需配置 `SCREENING_LLM_URL`/`SCREENING_LLM_KEY`，输出评分卡。

```bash
python3 <skill>/scripts/kol_screening.py --csv ... --samples ... --rules <skill>/screening_rules.json --out ..._scorecard.json --category 美食探店 --city 上海
```

### Step 6 · 互暖排查（可选，v2.6 新增）——筛选名单的虚假互动清理

在跑完全流程得到最终清洗后 CSV（`{产品}{城市}_清洗后.csv`）后，可对名单做**小红书站内互暖排查**，剔除互暖群 / 低质水军，避免投放给虚假互动的达人。

```bash
python3 <skill>/scripts/mutual_warm_pipeline.py \
    --csv {产品}{城市}_清洗后.csv \
    --id-column userId \
    --data-dir <workspace>/workspace-files/互暖数据 \
    --blacklist <skill>/blacklist.json \
    --cdp-port 9222 \
    --output {产品}{城市}_互暖排查结果.csv
```

> **关键概念（务必先读 `references/koc_detect_guide.md`）**：
> - 蒲公英筛选出的 `userId` **不是**站内 user_id（24 位 hex）。需先做 ID 关联：蒲公英 blogger 详情页可复制的"小红书号"可整理成映射文件，用 `--id-mapping` 传入；若无映射则默认把该列直接当站内 id 用（风险提示）。
> - 三层评分：评论者跨达人重合 60% + 黑名单命中 30% + KOC 画像 10%；模板率 >20% 一票否决。≥60 排除 / 40-60 复核 / <40 通过。
> - `koc_detect.py` 每轮把新实锤的互暖号累积写入 `~/.mapro/koc-blacklist.json`（本地），并与 skill 的 `blacklist.json`（默认基线）合并评分。
> - 前置条件：Chrome CDP（`--remote-debugging-port=9222`）已登录**小红书站内**（www.xiaohongshu.com），`pip install playwright httpx tenacity pyhumps xhshow>=0.2.0`。

Agent 在用户明确要求"互暖排查 / 排除互暖号 / 虚假互动清理 / 评论交叉检测 / KOC 互暖"时执行本步骤；否则跑完阶段8 即可交付。

## 产出物（全部在 workspace-files/，命名与 `examples/pipeline_similar.sh` 一致）

| 文件 | 说明 |
|------|------|
| `config_{产品}_{城市}.json` | 筛选参数 |
| `{产品}{城市}采集结果.csv` | 阶段1 主采集结果（含互动/评论中位数） |
| `{产品}{城市}_筛选后.csv` | 阶段2 通过名单 |
| `{产品}{城市}_interact.csv` | 阶段3 删互动<100 后（中间） |
| `{产品}{城市}_健康.csv` | 阶段3 健康筛选后 |
| `{产品}{城市}_top8.json` | 阶段4 top-8 曝光/点赞/标题/正文 |
| `{产品}{城市}最终结果.csv` | 阶段5 最终结果（31列） |
| `{产品}{城市}_拆分/{产品}{城市}最终结果_合作笔记非0.csv` | 阶段6 拆分输出（**带 base 前缀**；另有一个 `_合作笔记0.csv`） |
| `{产品}{城市}_打分输入.csv` | 阶段7 CPE 硬性过滤后（打分输入） |
| `{产品}{城市}_打分.csv` | 阶段8 打分名单（38列） |
| `{产品}{城市}_清洗后.csv` | **最终名单（交付）** |
| `{产品}{城市}_互暖排查结果.csv` | 阶段9 互暖排查结果（在原名单追加 互暖分/模板率/互暖结论 列，可选） |

## CSV 字段清单

**采集结果 CSV（v2.3）**：达人名称 / 小红书号 / 内容类目 / 地域 / 粉丝量 / 粉丝所在区域（前五城市）/ 获赞与收藏 / 图文报价（万）/ 视频报价（万）/ 女性粉丝占比 / 日常笔记发布篇数·曝光·阅读·点赞·**互动·评论**中位数 / 合作笔记发布篇数·曝光·阅读·点赞·**互动·评论**中位数 / 合作笔记最低曝光·最低点赞（明细）/ 内容标签 / 擅长标签 / 预估CPM / 预估CPE / 数据来源。（日常与合作均取「仅自然流量」`advertiseSwitch=0`，近 30 天。**相关帖子抽样/评论样本默认不采集**——确定性打分流程不需要。）

**最终打分名单（38 列）**：见 `references/pipeline.md` 第 5 节。

## 关键原则

1. CDP 始终使用用户已打开的 Chrome，不启动新浏览器实例
2. 搜索 payload 必须完整（模板字段全保留），只替换筛选值
3. 详情页临时标签页用完即关；每 KOL 外层重试 2 次，失败不中断整体
4. CSV 增量写入 + 断点续采按 userId 去重
5. **只写 config JSON，不写采集脚本**——采集器与流水线脚本都在 `scripts/`
6. 所有产出在 `<workspace>/workspace-files/`
7. 平台专注：仅小红书蒲公英
8. **易错点 13 条**（拆分目录/带前缀文件名/HEADERS 同步/报价范围/纯旅游美妆口径/活跃度/粉丝地域/沪杭判断/果切/日志/CDP）见 `references/pipeline.md` 第 4 节

## 速查

- **沪杭·生活美食探店**（推荐示例）：`examples/config-hanghai-food-tandian.json`（含 v2.3 严格筛选字段）
- **上海美食探店（宽松）**：`examples/config-shanghai-food-tandian.json`
- **寻找相似模式**：`examples/config-similar-kol.json`（以某达人为种子，填 `similar_user_id` + `similar_word`）

```bash
# 环境自检
python3 <skill>/scripts/kol_collector.py --check --port 9222
# 复制示例并采集（常规关键词）
cp <skill>/examples/config-hanghai-food-tandian.json <workspace>/workspace-files/config_沪杭探店.json
python3 <skill>/scripts/kol_collector.py --config <workspace>/workspace-files/config_沪杭探店.json
# 寻找相似模式：把 config 里的 similar_user_id/similar_word 填上种子达人即可
cp <skill>/examples/config-similar-kol.json <workspace>/workspace-files/config_相似达人.json
python3 <skill>/scripts/kol_collector.py --config <workspace>/workspace-files/config_相似达人.json
# 之后按 references/pipeline.md 执行阶段2-8；完整命令可直接参照 <skill>/examples/pipeline_similar.sh（已含 mkdir -p 与带前缀文件名）
```

## 版本历史

- **v2.6.0**（2026-08-23）：新增**阶段9 互暖排查**——移植自 MediaCrawler 的互暖检测体系，MAPro skill 完全自包含，不再依赖 MediaCrawler 项目：
  - `scripts/collect_creator_xhs.py`：小红书站内 KOL 笔记+评论采集（复用 CDP 登录态 + xhshow 纯算法签名），产出与 MediaCrawler 一致的 `creator_{contents,comments}_*.jsonl`
  - `scripts/koc_detect.py`：互暖三层评分（评论者跨达人重合60% + 黑名单命中30% + KOC画像10%，模板率>20%一票否决），双文件黑名单：默认版只读基线 + 本地累积版
  - `scripts/mutual_warm_pipeline.py`：阶段9 编排（读清洗后CSV→关联蒲公英ID→采集→检测→合并互暖分/结论写回CSV）
  - `blacklist.json`：互暖黑名单·出厂默认基线（随版本分发，只读，含既有 17 个已实锤互暖号）
  - 黑名单**双文件存储**：评分合并 `blacklist.json`（基线）+ `~/.mapro/koc-blacklist.json`（本地累积，koc_detect 每轮把新实锤号写回），不被 skill 更新覆盖
  - `references/koc_detect_guide.md`：互暖排查手册（评分逻辑/数据schema/分步命令/黑名单）
  - SKILL.md 新增 Step 6 / 产出物新行 / 何时使用补充互暖应用场景
- **v2.5.4**（2026-08-13）：修正阶段5 输入口径——`estimate_cpe_cpm.py --csv` 必须用**阶段3 健康名单**（`健康.csv`），示例 `pipeline_similar.sh` 由阶段2 筛选后名单修正为健康名单，pipeline.md 阶段5 章节强调 + 易错点扩至 14 条；顺带修正 Step 4 概览「7 阶段」→「8 阶段」。
- **v2.5.3**（2026-08-13）：统一「点赞率」口径为**日常笔记**近30日仅自然流量（日常点赞中位数 ÷ 日常阅读中位数）——健康筛选（`filter_health.py` 由合作笔记口径修正为日常笔记口径）、打分（`score_kols.py`，本就日常口径）、CSV「阅读与点赞占比」列（`add_ratio_cols.py`，本就日常口径）三处一致。
- **v2.5.2**（2026-08-13）：产出物表与 `examples/pipeline_similar.sh` 命名对齐——补齐阶段3-7 中间产物（interact/健康/top8/拆分/打分输入），最终名单明确为 `{产品}{城市}_清洗后.csv`。
- **v2.5.1**（2026-08-13）：修复拆分阶段两个叠加坑并沉淀——① `split_zero.py` 输出目录不存在时自动 `makedirs`（此前直接 `open` 抛 FileNotFoundError）；② 明确拆分输出文件名带 base 前缀（`<目录>/<输入名>_合作笔记非0.csv`），阶段7/8 引用必须带前缀；新增 `examples/pipeline_similar.sh` 完整流水线命令示例（含 mkdir -p 与带前缀路径），pipeline.md 易错点增至 13 条。
- **v2.5.0**（2026-08-13）：新增**阶段7 CPE 硬性过滤**（`filter_cpe.py`，打分前去掉预估CPE>50，`--max-cpe` 可配，流水线扩为 8 阶段）；**寻找相似防误判**——Step 2b / pipeline 第0章新增任务判定规则（寻找相似任务必须一开始就走 kolSimilar，config 只含 similar 字段，keywords 留空、不配 strict_*），示例 `config-similar-kol.json` 精简为只含 similar 字段，`kol_collector.py` similar 模式强制关闭 strict 搜索。
- **v2.4.1**（2026-08-13）：同步「寻找相似（kolSimilar）模式」至默认 skill，保留既有增强（抽样默认关闭 / score_kols.py 38 列精简输出 / 打分 5 列可替换接口）。
- **v2.4.0**（2026-08-13）：新增**寻找相似（kolSimilar）模式**——以某达人为种子批量拉取相似达人（config 配 similar_user_id/similar_word，走 blogger/v2 kolSimilar 通道 + 分页全量；筛选参数 gender/location/报价 对 kolSimilar 生效，可压缩 total）。新增 Step 2b 章节、examples/config-similar-kol.json 示例、版本号。
- **v2.3.3**（2026-08-13）：明确最终 CSV 末尾打分 5 列（CPE/点赞率/赞评比/爆文率得分+总分）为可替换接口——默认 4 维度确定性打分，改用其他打分方式（如 LLM 校验）时仅替换这 5 列。
- **v2.3.2**（2026-08-13）：`score_kols.py` 最终输出严格限定 38 列表头（33 列最终结果 + 4 维度打分 5 列），按总分降序，不再带入 userId 等中间列。
- **v2.3.1**（2026-08-13）：相关帖子抽样/评论明细默认关闭（`sample_note_count=0`、`grab_note_text=false`、`grab_comments=false`），确定性打分流程默认不采集抽样数据；示例 config 同步。
- **v2.3.0**（2026-08-13）：内置完整 7 阶段筛选流水线（初筛/删互动<100/top-8/沪杭复核估算/拆分/4维度打分/清洗）；新增严格交叉验证（`strict_search`/`strict_categories`/`strict_home_tags`/排除词/母婴）；`fans_region_cities` 粉丝地域沪杭浙；`search_column`/`search_sort` 排序；`skip_drawer_extraction` 跳抽屉提速；互动/评论中位数；纯旅游/纯美妆排除口径修正（类目不命中任一目标类目才排除）。新增 `references/pipeline.md`、流水线脚本、沪杭示例 config。
- **v2.2.0**（2026-08-02）：评论区画像真正可用（`grab_comments=true`）；CSV 新增「评论样本用户/评论样本文本」。
- **v2.1.0**（2026-08-01）：相关帖子抽样；校验引擎 `kol_screening.py`（四条规则→评分卡）；`screening_rules.json` 规则配置。
- **v2.0.3**（2026-08-02）：修复最低曝光/最低点赞/CPM/CPE 数据源（抽屉 `ex()` 布局 + 万/千单位；互动字段 API 优先、抽屉兜底）。
- **v2.0.2**（2026-08-01）：末尾合并写入防丢；userId 独立列 + csv 模块断点。
- **v2.0.1**（2026-08-01）：location 省市区 token 匹配；搜索阶段检查 featureTags；CDP 自动重连；断点续采。
- **v2.0.0**（2026-08-01）：通用采集器 + config JSON，Agent 自动执行。
