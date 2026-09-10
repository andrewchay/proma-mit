# 蒲公英 KOL 完整筛选流水线（8 阶段，v2.5）

> 与 SKILL.md 配套。SKILL.md 是编排总纲，本文档承载完整细节：config 字段、各阶段筛选条件、打分规则、易错点、38 列表头、CDP 监督续采、命令示例。

## 0. 寻找相似（kolSimilar）模式

> **⚠️ 任务判定（v2.5 防误判）**：用户说「寻找相似」「以 XX 达人为种子找同类博主」「按昵称找相似达人」「更多操作里的寻找相似」→ **必须一开始就走 kolSimilar 通道**，不要准备关键词搜索的 config。config 只需 `similar_user_id` + `similar_word`（+ 筛选参数），**keywords 留空、不配 strict_search / strict_* 字段**（采集器在 similar 模式下会强制关闭 strict 搜索）。完整示例直接照抄 `examples/config-similar-kol.json`。

当 config 配置了 `similar_user_id`（+ 可选 `similar_word`），采集器自动走**寻找相似**通道，其余流程（详情采集 + 阶段2-8）与常规关键词搜索完全一致。

- **接口**：`POST /api/solar/cooperator/blogger/v2`，trackId 前缀 `kolSimilar_`，payload 增加 `similarUserId` / `similarWord`。
- **分页**：与关键词搜索相同，`pageNum` 递增拉全量（pageSize=20），`data.total` 为相似达人总数。
- **筛选参数对 kolSimilar 生效**：`gender` / `location` / `notePriceLower` / `notePriceUpper` / `fansNumberLower` / `fansNumberUpper` 等会压缩 total（实测 Milchstraße 种子：无筛选 979 → 全筛选 272）。**配置时务必带上筛选**，否则会采到大量无关达人。
- **粉丝地域（fansLocation）不可用**：按城市名传返回 0，需在阶段2 用 `fans_region_cities`（详情页 fans_profile top5）过滤。
- **种子 userId 获取**：博主广场按昵称搜索 → 点搜索预测项 → 从 `blogger/v2` 的 `kolSearch_` 响应或详情页 API `/api/solar/cooperator/user/blogger/{uid}` 拿 `userId`。也可直接在页面"更多操作→寻找相似"时从抓包 `kolSimilar_` 请求体读 `similarUserId`。

## 1. config 字段表（v2.5，含示例值）

| 字段 | 示例 | 说明 |
|------|------|------|
| `keywords` | `["探店","美食","生活记录","plog","氛围感","职场生活","高级感"]` | 搜索关键词（searchType=1 内容搜索，非按昵称） |
| `gender` | `"女"` | 不限/男/女 |
| `location_cities` | `["杭州","上海"]` | 博主地域 |
| `fans_location_cities` | `[]` | 粉丝地域搜索（搜索 API 不按城市名过滤，留空） |
| `target_cities` | `["杭州","上海"]` | 详情页城市过滤（博主地域） |
| `fans_region_cities` | `["上海","杭州","宁波",...12城]` | 粉丝地域允许城市（详情页粉丝画像 top5 判断） |
| `note_price_lower/upper` | `500 / 20000` | 报价范围（元） |
| `fans_number_lower/upper` | `0 / 5000000` | 粉丝量范围 |
| `max_pages` | `100` | 每关键词最大翻页（实际按 total 翻完即停，勿设太小） |
| `search_column` | `"fansCount"` | 搜索排序字段（粉丝量） |
| `search_sort` | `"asc"` | 升序（小粉丝在前） |
| `skip_drawer_extraction` | `true` | 主采集跳过点抽屉（仅 API 中位数，提速；top8 再点抽屉） |
| `active_within_days` | `0` | 0=关闭活跃度过滤（用户未要求则关） |
| `strict_search` | `true` | 开启严格 a AND b 交叉验证 |
| `strict_categories` | `["美食探店","美食","生活记录","家居家装","家居用品","时尚","穿搭","生活"]` | 内容类目目标集合（一级+二级合并判断，任一命中即可） |
| `strict_home_tags` | `["互联网打工人","精致宝妈","氛围感","高级感","plog","职场生活","探店","ootd","韩系"]` | 主页标签目标集合（擅长标签，任一命中即可） |
| `strict_exclude_words` | `["大学生","宠物","搞笑","知识付费","课程","培训","备考","留学"]` | 其他排除词（标签命中即排除） |
| `strict_maternal_words` | `["母婴","育儿","孕产","孕期","带娃","辅食","婴幼儿"]` | 母婴类（主页标签含精致宝妈才放行） |
| `strict_maternal_pass` | `"精致宝妈"` | 母婴放行标签 |
| `strict_pure_words` | `["旅游","旅行","出行","美妆"]` | 纯旅游/纯美妆排除词（内容类目不命中任一 `strict_categories`、命中这些词才排除） |
| `force_redownload_ids` | `[]` | 强制重采指定 userId（搜索搜不到时按昵称 searchType=2 补采用） |

> 纯旅游/纯美妆排除口径：**仅当内容类目不命中任一 `strict_categories`、且命中旅游/美妆类目时排除**（混合类目如"美食;出行旅游"、"时尚;出行旅游"保留）。

## 2. 8 阶段流程

| 阶段 | 脚本 | 命令 | 产出 |
|------|------|------|------|
| 0 环境 | `kol_collector.py` | `python3 kol_collector.py --check --port 9222` | CDP + 登录态确认 |
| 1 主采集 | `kol_collector.py` | `python3 kol_collector.py --config config.json` | 采集结果CSV（含互动/评论中位数） |
| 2 初筛 | `screen_v2.py` | `python3 screen_v2.py --csv 采集结果.csv --out 筛选后.csv [--config config.json] [--female-min 0.70] [--min-notes 4] [--price-lo 0.05 --price-hi 2.0] [--fans-cities 上海 杭州 ...]` | 通过名单（参数化：类目/标签/女性占比/篇数/报价/粉丝地域可配置） |
| 3 健康筛选 | `filter_interact.py` → `filter_health.py` | `python3 filter_interact.py <coop.csv> <out1> 100`；`python3 filter_health.py --csv <out1> --out <健康.csv> [--lo 1.6 --hi 12]` | 健康 coop 名单（①删互动中位数<100；②删点赞率不健康，日常笔记口径） |
| 4 top-8采集 | `top8_extractor.py` | `python3 top8_extractor.py --csv coop.csv --out top8.json` | top8.json（曝光/点赞/标题/正文，断点续采） |
| 5 沪杭复核+估算 | `estimate_cpe_cpm.py` | `python3 estimate_cpe_cpm.py --csv 健康.csv --pop 采集结果.csv --top8 top8.json --out 最终结果.csv [--city-words 上海 杭州]` | 最终结果CSV（31列；**输入=阶段3 健康名单**；top8 命中任一城市词→通过，可配置） |
| 6 拆分 | `split_zero.py` | `mkdir -p <目录> && python3 split_zero.py 最终结果.csv <目录>` | 合作0 / 合作非0（**文件名带输入前缀**：`<目录>/<输入名>_合作笔记非0.csv`） |
| 7 CPE硬性过滤 | `filter_cpe.py` | `python3 filter_cpe.py --csv <目录>/<输入名>_合作笔记非0.csv --out 打分输入.csv [--max-cpe 50]` | 去掉预估CPE>50（硬性条件，打分前） |
| 8 打分+清洗 | `add_ratio_cols.py` → `score_kols.py` → `clean_final.py` | `score_kols.py --csv 打分输入.csv --out 打分.csv`；`clean_final.py --csv 打分.csv --out 清洗后.csv [--categories 美食 ...] [--guoqie-words 果切 ...]` | 打分名单 + 清洗后名单（38列） |

> **拆分文件命名约定（v2.5.1）**：`split_zero.py` 输出文件名带输入 CSV 的 base 前缀——`<目录>/<输入名>_合作笔记0.csv` 与 `<目录>/<输入名>_合作笔记非0.csv`（base 取自输入文件名去掉扩展名，**非固定名** `合作笔记非0.csv`）。**后续阶段（7/8）引用必须带前缀**，否则找不到文件。脚本已自动创建输出目录（`makedirs`），手动运行前先 `mkdir -p <输出目录>` 双保险。完整命令示例见 `examples/pipeline_similar.sh`。

> **业务规则参数化（v2.3）**：女性占比（`--female-min`）、篇数（`--min-notes`）、报价范围（`--price-lo/hi`）、沪杭复核城市词（`--city-words`）、清洗目标类目与雷区词（`--categories`/`--food-words`/`--guoqie-words`）均按 campaign 可配置，不写死。初筛的类目/标签/粉丝地域可用 `--config` 读取 config JSON 的 `strict_*` 字段覆盖默认。

### 阶段2 初筛条件（screen_v2.py）
- 内容类目命中 `strict_categories` **且** 主页标签命中 `strict_home_tags`（a AND b，交叉验证）
- 纯旅游/纯美妆：内容类目不命中目标类目才排除
- 女性粉丝占比 ≥ 70%
- 近30天日常+合作篇数和 ≥ 4
- 粉丝地域 top5 命中沪杭浙（`fans_region_cities`）
- 图文或视频报价任一在 0.05万~2万（500~20000元）
- 沪杭笔记判断移到 top-8 复核（主采集无正文，仅凭标题不可靠）

### 阶段3 健康筛选（filter_interact.py + filter_health.py）
- **① 删互动中位数<100**：删近30日合作笔记（仅自然流量）互动中位数 <100
- **② 删点赞率不健康**：点赞率 = **日常笔记**点赞中位数 ÷ 日常笔记阅读中位数（近30日仅自然流量；与打分、CSV「阅读与点赞占比」列**同一口径**），保留在 **[1.6%, 12%]** 内（即 2%~10% 健康区间 ±20% 容差），否则淘汰；阈值用 `--lo/--hi` 配置

### 阶段5 沪杭复核 + CPM/CPE 估算（estimate_cpe_cpm.py）

> **⚠️ 输入必须是阶段3 健康筛选后的名单（`健康.csv`），勿用阶段2 筛选后名单**——否则被阶段3 淘汰（互动<100 / 点赞率不健康）的达人会经 estimate 被打回最终名单，筛选口径不一致（本次与 Milch 实操均为健康.csv）。

- 沪杭复核：top-8 标题/正文含「上海」或「杭州」→ 通过；无沪杭 → 淘汰
- 大盘：全量采集CSV的**合作笔记曝光/点赞中位数**（近30日仅自然流量，>0）→ P50=中位数、P10=10%分位、R=P10/P50
- Tweedie 收缩（φ=2）：`预估最低值 = (n×样本P10 + 2×M_个体×R) / (n+2)`，n=top8样本条数
- `CPM = 报价 ÷ 预估最低曝光 × 1000`；`CPE = 报价 ÷ 预估最低点赞`
- 报价取图文/视频报价中较小且 >0 的那个（0 视为无此类型报价）

### 阶段7 CPE 硬性过滤（filter_cpe.py，v2.5 新增）

**业务硬性条件**：去掉预估CPE > 50 的达人，不满足直接淘汰（不参与打分）。阈值用 `--max-cpe` 配置；后续新增硬性条件沿用本脚本参数化扩展。

```bash
python3 filter_cpe.py --csv 合作笔记非0.csv --out 打分输入.csv --max-cpe 50
```
- 只读「预估CPE」列，CPE 为空/非数值的保留（不误杀），数值 > 阈值才淘汰
- 输出保留全部原有列，后续 `add_ratio_cols.py` / `score_kols.py` / `clean_final.py` 改从「打分输入.csv」读取

## 3. 4 维度打分规则（满分 100，score_kols.py）

| 维度 | 满分 | 规则 |
|------|------|------|
| CPE | 50 | >20→0；15~20→20；10~15→30；5~10→40；0~5→50 |
| 点赞率=日常点赞÷日常阅读 | 20 | 2%~10%→20，其他→0 |
| 赞评比=点赞÷评论 | 20 | ≤5→20；5~8→12；>8→0 |
| 爆文率 | 10 | 粉丝<1万且日常互动≥500，或≥1万且≥1000 →10；否则0 |

命令：`python3 score_kols.py --csv 合作笔记非0.csv --out 打分.csv`

> 与 `kol_screening.py`（LLM 四规则校验）**二选一，勿混合计分**。确定性打分可复现，推荐；LLM 校验需配置 LLM + 抽样笔记。

## 4. 易错点（14 条）

1. **拆分输出目录不存在 → FileNotFoundError**：`split_zero.py` 直接 `open(<目录>/<名>)`，目录不存在即崩（如 `道明寺猴相似达人_拆分/...`）。脚本已自动 `makedirs`（v2.5.1），手动运行仍先 `mkdir -p <输出目录>`。
2. **拆分文件名带 base 前缀**：输出是 `<目录>/<输入名>_合作笔记非0.csv` 而非固定 `合作笔记非0.csv`——后续阶段引用必须带前缀，否则找不到文件（Milch 那次就是目录不存在 + 前缀不符叠加踩坑）。
3. **改采集器加列必须同步 `HEADERS`**：build_row 加新列漏改 HEADERS → 写入 ValueError 崩溃。
4. **旧表头 + 新列错位**：HEADERS 修复前已写表头的旧 CSV，追加新数据行列错位、去重失效 → 应清空重采。
5. **报价范围残留**：estimate 报价范围应设 `0~1e7` 且忽略 0 报价（否则 CPM 空）；本次按业务设 500~20000。
6. **纯旅游/美妆排除口径**：勿用「标签命中即排除」误伤混合类目，应「内容类目不命中任一目标类目才排除」。
7. **活跃度过滤默认开**：用户未要求时设 `active_within_days=0` 关闭。
8. **粉丝地域漏浙江**：判断需含浙江 12 城（`fans_region_cities`）。
9. **沪杭笔记判断**：须在 top-8 用完整标题/正文复核（主采集跳过抽屉无正文，仅凭标题会误杀，如「河坊街挖到宝」无杭州字样）。
10. **果切判断**：真果切/果切外卖才排除（西瓜桶果切、`#上海果切#`、点果切外卖）；「鲜切」多是牛肉/凤梨等配料。
11. **日志缓冲**：重定向输出用 `python3 -u`，否则进度不显示。
12. **CDP 不稳定**：EPIPE/TargetClosed/内存 → 重启采集器续采（断点续采不丢数据）。
13. **打分前漏 CPE 硬性过滤**：预估CPE>50 的达人须用 `filter_cpe.py` 在打分前淘汰（硬性条件），勿混进打分名单；CPE 列缺失或全空时先跑阶段5 估算。
14. **阶段5 输入用了阶段2 名单**：`estimate_cpe_cpm.py --csv` 必须传**阶段3 健康名单**（健康.csv），勿传阶段2 筛选后.csv——否则阶段3 淘汰（互动<100/点赞率不健康）的达人会被 estimate 打回最终名单，筛选口径不一致。

## 5. 38 列最终表头（打分清洗后）

```
达人名称 | 小红书号 | 内容类目 | 地域 | 粉丝量 | 粉丝所在区域（前五城市）| 获赞与收藏 | 图文报价（万）| 视频报价（万）| 女性粉丝占比
日常笔记发布篇数 | 日常笔记曝光中位数 | 日常笔记阅读中位数 | 日常笔记点赞中位数 | 日常笔记互动中位数 | 日常笔记评论中位数
阅读与点赞占比(=点赞÷阅读) | 赞评比
合作笔记发布篇数 | 合作笔记曝光中位数 | 合作笔记阅读中位数 | 合作笔记点赞中位数 | 合作笔记互动中位数 | 合作笔记评论中位数
内容标签 | 擅长标签 | 预估最低曝光 | 预估最低点赞 | 预估CPM | 预估CPE | top8帖子标题 | top8帖子正文 | 数据来源
CPE得分 | 点赞率得分 | 赞评比得分 | 爆文率得分 | 总分
```
（31 列 = estimate 输出；+add_ratio 2 列 = 33；+score 5 列 = 38）

> **打分 5 列是可替换接口**：默认 4 维度确定性打分（`score_kols.py`，CPE得分/点赞率得分/赞评比得分/爆文率得分/总分）。若改用其他打分方式（如 `kol_screening.py` LLM 四规则校验），**只替换末尾打分 5 列**，前 33 列保持不变。

## 6. CDP 监督续采循环

采集器断点续采按 userId 去重、增量写 CSV。长时间采集建议循环驱动：
1. 每轮运行采集器/`top8_extractor.py`（`--limit` 分批）
2. 检测 CSV/top8.json 是否增长（90s×4 无增长判定挂死）
3. 挂死或崩溃 → 重启 Chrome（`--remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug`，隔离配置保登录态）→ 续跑
4. 日志用 `python3 -u` 实时可见

## 7. 补充说明

- **searchType**：`searchType=1` 是**笔记内容搜索**（匹配笔记标题/正文/话题，非达人标签档案）；`searchType=2` 是**按昵称搜索**。内容搜索对部分达人（标签匹配但笔记内容不体现关键词）搜不到 → 需 searchType=2 按昵称补采（`force_redownload_ids`）。
- **一级/二级类目**：蒲公英内容类目为两级，`taxonomy1Tag`（如 美食/生活记录/时尚）→ `taxonomy2Tags`（如 美食探店/穿搭）。筛选时合并成集合判断，**任一命中目标即可**。
- **报价限制**：本次业务 500~20000 元；不同业务在 config 的 `note_price_lower/upper` 与 screen_v2 的报价检查里同步改。
- **相关帖子抽样/评论样本**：确定性打分流程下**默认不采集**（config 不配 `sample_note_count`/`relevance_keywords`/`grab_note_text`/`grab_comments`/`notes_samples_file`）；仅走 LLM 圈选校验（`kol_screening.py`）时才需要抽样笔记。
