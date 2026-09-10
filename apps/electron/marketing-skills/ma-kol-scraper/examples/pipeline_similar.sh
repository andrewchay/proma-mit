#!/usr/bin/env bash
# 蒲公英 KOL 完整 8 阶段流水线命令示例（相似达人场景，v2.5.1）
#
# 用法：把下面的 SKILL / WS / BASE 改成实际值后整段复制执行；
# 或作为参考模板，按 references/pipeline.md 逐步手敲。
#
# 关键约定（v2.5.1 沉淀，避免再踩坑）：
#   - 阶段6 split_zero.py 输出文件名带输入 CSV 的 base 前缀，
#     `<目录>/<输入名>_合作笔记非0.csv`（非固定名 合作笔记非0.csv）
#   - 阶段7/8 引用拆分文件必须带前缀，否则找不到文件
#   - 阶段6 前先 mkdir -p 输出目录（脚本已自动创建，手动建双保险）
#   - 阶段5 输入必须用阶段3 健康名单（健康.csv），勿用阶段2 筛选后名单，
#     否则阶段3 淘汰的达人会被 estimate 打回最终名单，筛选口径不一致

set -euo pipefail

SKILL="<skill>"                                     # skill 目录绝对路径
WS="<workspace>"                                    # 当前工作区目录
CONFIG="$WS/workspace-files/config_相似达人.json"    # config（similar 场景只含 similar 字段）
BASE="相似达人"                                      # 业务名，改成实际名称（如 道明寺猴相似达人）

# ---- 阶段0 环境自检 ----
python3 -u "$SKILL/scripts/kol_collector.py" --check --port 9222

# ---- 阶段1 主采集 ----
python3 -u "$SKILL/scripts/kol_collector.py" --config "$CONFIG"

# 主采集输出：$WS/workspace-files/${BASE}采集结果.csv
COLLECTED="$WS/workspace-files/${BASE}采集结果.csv"

# ---- 阶段2 初筛 ----
python3 -u "$SKILL/scripts/screen_v2.py" \
  --csv "$COLLECTED" \
  --out "$WS/workspace-files/${BASE}_筛选后.csv" \
  --config "$CONFIG" --fans-cities 上海 杭州

# ---- 阶段3 健康筛选（删互动<100 + 删点赞率不健康；点赞率=日常笔记口径）----
python3 -u "$SKILL/scripts/filter_interact.py" "$WS/workspace-files/${BASE}_筛选后.csv" "$WS/workspace-files/${BASE}_interact.csv" 100
python3 -u "$SKILL/scripts/filter_health.py" --csv "$WS/workspace-files/${BASE}_interact.csv" --out "$WS/workspace-files/${BASE}_健康.csv" --lo 1.6 --hi 12

# ---- 阶段4 top-8 采集（点抽屉记曝光/点赞/标题/正文，断点续采）----
python3 -u "$SKILL/scripts/top8_extractor.py" --csv "$WS/workspace-files/${BASE}_健康.csv" --out "$WS/workspace-files/${BASE}_top8.json"

# ---- 阶段5 沪杭复核 + CPM/CPE 估算（输入=阶段3 健康名单！）----
python3 -u "$SKILL/scripts/estimate_cpe_cpm.py" \
  --csv "$WS/workspace-files/${BASE}_健康.csv" \
  --pop "$COLLECTED" \
  --top8 "$WS/workspace-files/${BASE}_top8.json" \
  --out "$WS/workspace-files/${BASE}_最终结果.csv" \
  --city-words 上海 杭州

# ---- 阶段6 拆分（目录先建；输出文件名带 base 前缀！）----
FINAL="$WS/workspace-files/${BASE}_最终结果.csv"
OUTDIR="$WS/workspace-files/${BASE}_拆分"
mkdir -p "$OUTDIR"
python3 -u "$SKILL/scripts/split_zero.py" "$FINAL" "$OUTDIR"
# 实际生成：$OUTDIR/${BASE}_最终结果_合作笔记0.csv 与 ${BASE}_最终结果_合作笔记非0.csv

# ---- 阶段7 CPE 硬性过滤（>50 淘汰，打分前）----
NONZERO="$OUTDIR/${BASE}_最终结果_合作笔记非0.csv"    # ← 带 base 前缀，勿写成 合作笔记非0.csv
python3 -u "$SKILL/scripts/filter_cpe.py" --csv "$NONZERO" --out "$WS/workspace-files/${BASE}_打分输入.csv" --max-cpe 50

# ---- 阶段8 打分 + 清洗 ----
python3 -u "$SKILL/scripts/score_kols.py" --csv "$WS/workspace-files/${BASE}_打分输入.csv" --out "$WS/workspace-files/${BASE}_打分.csv"
python3 -u "$SKILL/scripts/clean_final.py" --csv "$WS/workspace-files/${BASE}_打分.csv" --out "$WS/workspace-files/${BASE}_清洗后.csv"

echo "完成：$WS/workspace-files/${BASE}_清洗后.csv"
