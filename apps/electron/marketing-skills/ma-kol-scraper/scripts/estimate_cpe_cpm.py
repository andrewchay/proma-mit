"""基于 Tweedie 收缩法估算每位达人的预估 CPM / CPE，并写入 CSV。

方案（剪贴板，φ=2）：
  第1步 大盘：对全部达人的「近90日合作笔记曝光中位数」X 与「中位点赞数」Y，
        计算 P50=中位数、P10=底部10%分位数，收缩比率 R = P10/P50（曝光/点赞各自计算）。
  第2步 个体：某达人前8条合作笔记样本 → M_个体=中位数、样本P10=最低值，
        先验最低估值 Prior_Min = M_个体 × R。
  第3步 最终Min估值 = (n × 样本P10 + φ × Prior_Min) / (n + φ)，n=样本条数，φ=2。
  第4步 CPE = 合作报价 / 最终Min点赞估值；CPM = (合作报价 / 最终Min曝光估值) × 1000。

合作报价 = 图文/视频报价中落在 0.1万-0.5万 内的较小者（与采集器 effective_price 口径一致）。

⚠️ 输入（--csv）必须是**阶段3 健康筛选后的名单**（健康.csv），勿用阶段2 筛选后名单——否则被阶段3 淘汰的达人会被打回最终名单，筛选口径不一致。

用法: python3 estimate_cpe_cpm.py --csv <阶段3健康名单.csv> --top8 top8_notes.json [--out xxx_estimate.csv]
"""
import argparse, csv, json, os, statistics
import numpy as np

PHI = 2.0
PRICE_LOWER, PRICE_UPPER = 0, 10000000


def p10_median(vals):
    vals = sorted(float(v) for v in vals if v is not None)
    if not vals:
        return None, None
    med = float(np.median(vals))
    lo = float(np.percentile(vals, 10))
    return med, lo


def effective_price(pic_wan, vid_wan):
    """报价（万）→ 元；取图文/视频报价中较小且 >0 的那个（0 视为无此类型报价）。"""
    cands = []
    for v in (pic_wan, vid_wan):
        if v is None:
            continue
        try:
            yuan = float(v) * 10000
        except (TypeError, ValueError):
            continue
        if yuan <= 0:
            continue
        cands.append(yuan)
    in_range = [c for c in cands if PRICE_LOWER <= c <= PRICE_UPPER]
    if in_range:
        return min(in_range)
    return min(cands) if cands else None


def shrink_min(sample_vals, pop_p50, pop_p10):
    """返回 (最终Min估值, M_个体, 样本P10, n, R)。样本过少/缺大盘时回退。"""
    vals = [float(v) for v in sample_vals if v is not None and float(v) > 0]
    n = len(vals)
    if n == 0:
        return None, None, None, 0, None
    m_individual = float(np.median(vals))
    sample_p10 = min(vals)
    if pop_p50 and pop_p50 > 0 and pop_p10 is not None:
        r = pop_p10 / pop_p50
        prior_min = m_individual * r
        final_min = (n * sample_p10 + PHI * prior_min) / (n + PHI)
        return final_min, m_individual, sample_p10, n, r
    return sample_p10, m_individual, sample_p10, n, None


# 最终 CSV 仅输出用户要求的列（其余为内部计算数据，不输出）
OUTPUT_COLUMNS = [
    "达人名称", "小红书号", "内容类目", "地域", "粉丝量",
    "粉丝所在区域（前五城市）", "获赞与收藏",
    "图文报价（万）", "视频报价（万）", "女性粉丝占比",
    "日常笔记发布篇数", "日常笔记曝光中位数", "日常笔记阅读中位数", "日常笔记点赞中位数",
    "日常笔记互动中位数", "日常笔记评论中位数",
    "合作笔记发布篇数", "合作笔记曝光中位数", "合作笔记阅读中位数", "合作笔记点赞中位数",
    "合作笔记互动中位数", "合作笔记评论中位数",
    "内容标签", "擅长标签",
    "预估最低曝光", "预估最低点赞",
    "预估CPM", "预估CPE",
    "top8帖子标题", "top8帖子正文", "数据来源",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="待估算/输出的达人CSV")
    ap.add_argument("--top8", required=True)
    ap.add_argument("--out")
    ap.add_argument("--pop", default=None, help="大盘P50/P10数据源CSV（默认同 --csv；应传全量采集CSV）")
    ap.add_argument("--only-complete", action="store_true",
                    help="只输出有 top8 数据且算出 CPM/CPE 的达人")
    ap.add_argument("--city-words", nargs="*", default=["上海", "杭州"],
                    help="沪杭复核：top-8 标题/正文命中任一城市词即通过（不同 campaign 可改）")
    args = ap.parse_args()

    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        reader = list(csv.DictReader(f))

    with open(args.top8, encoding="utf-8") as f:
        top8 = json.load(f)

    # 大盘（曝光 X / 点赞 Y）：本次需求口径——合作笔记（图文+视频）近30日、仅自然流量
    # 的曝光中位数/点赞中位数。用 --pop 指定的全量数据（默认同 --csv），
    # 仅统计有合作笔记（近30日中位数>0）的达人，
    # 排除无合作笔记的 0 值，避免把底部 10% 分位数拉到 0 导致收缩比率 R=0。
    pop_path = args.pop or args.csv
    with open(pop_path, newline="", encoding="utf-8-sig") as f:
        pop_reader = list(csv.DictReader(f))
    X = [float(r["合作笔记曝光中位数"]) for r in pop_reader
         if r.get("合作笔记曝光中位数") not in (None, "")
         and float(r["合作笔记曝光中位数"]) > 0]
    Y = [float(r["合作笔记点赞中位数"]) for r in pop_reader
         if r.get("合作笔记点赞中位数") not in (None, "")
         and float(r["合作笔记点赞中位数"]) > 0]
    med_x, lo_x = p10_median(X)
    med_y, lo_y = p10_median(Y)
    r_x = (lo_x / med_x) if med_x and lo_x is not None and med_x > 0 else None
    r_y = (lo_y / med_y) if med_y and lo_y is not None and med_y > 0 else None
    print(f"大盘曝光: P50={med_x} P10={lo_x} R={r_x} (n={len(X)})")
    print(f"大盘点赞: P50={med_y} P10={lo_y} R={r_y} (n={len(Y)})")

    updated = []
    n_missing_top8 = 0
    n_city_fail = 0
    for r in reader:
        uid = (r.get("userId") or "").strip()
        t = top8.get(uid) if uid else None
        if not t:
            n_missing_top8 += 1
        imp_vals = t.get("imp") if t else []
        like_vals = t.get("like") if t else []
        comments = t.get("comments") if t else []
        r["评论样本用户"] = " | ".join(dict.fromkeys(c.get("user", "") for c in comments if c.get("user")))[:600]
        r["评论样本文本"] = " || ".join(c.get("text", "") for c in comments if c.get("text"))[:2000]
        titles = t.get("titles") if t else []
        r["top8帖子标题"] = " | ".join(titles)[:2000]
        texts = t.get("texts") if t else []
        r["top8帖子正文"] = " | ".join(texts)[:2000]

        price = effective_price(
            float(r["图文报价（万）"]) if r.get("图文报价（万）") not in (None, "") else None,
            float(r["视频报价（万）"]) if r.get("视频报价（万）") not in (None, "") else None,
        )

        fin_x, _, _, _, _ = shrink_min(imp_vals, med_x, lo_x)
        fin_y, _, _, _, _ = shrink_min(like_vals, med_y, lo_y)
        # Tweedie 收缩估计的最低曝光数 / 最低点赞数（最终Min估值）
        r["预估最低曝光"] = round(fin_x, 1) if fin_x is not None else ""
        r["预估最低点赞"] = round(fin_y, 1) if fin_y is not None else ""

        cpm = None
        cpe = None
        if price:
            if fin_x:
                cpm = price / fin_x * 1000
            if fin_y:
                cpe = price / fin_y
        r["预估CPM"] = round(cpm, 2) if cpm is not None else ""
        r["预估CPE"] = round(cpe, 2) if cpe is not None else ""
        # 有 top8 数据（即采到了合作笔记）→ 沪杭复核：无沪杭相关笔记则淘汰
        # 无 top8 数据（近30天无合作笔记）→ 保留，top8/CPM/CPE 为空
        if t:
            city_text = " ".join((t.get("titles") or []) + (t.get("texts") or []))
            if not any(c in city_text for c in args.city_words):
                n_city_fail += 1
                continue
        updated.append(r)

    if args.only_complete:
        updated = [r for r in updated
                   if (str(r.get("预估CPM")) not in ("", "None")
                       or str(r.get("预估CPE")) not in ("", "None"))]

    out = args.out or args.csv
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=OUTPUT_COLUMNS, extrasaction="ignore")
        w.writeheader()
        w.writerows(updated)
    print(f"已写入 {out}，共 {len(updated)} 行，缺少 top8 数据 {n_missing_top8} 个，沪杭复核淘汰 {n_city_fail} 个")
    print(f"输出列 {len(OUTPUT_COLUMNS)} 个: {', '.join(OUTPUT_COLUMNS)}")
    # 摘要
    print("\n前5行预览（名称/报价/CPM/CPE）:")
    for r in updated[:5]:
        print(f"  {r['达人名称']}: 报价={effective_price(float(r['图文报价（万）']) if r.get('图文报价（万）') not in (None,'') else None, float(r['视频报价（万）']) if r.get('视频报价（万）') not in (None,'') else None)} CPM={r['预估CPM']} CPE={r['预估CPE']}")


if __name__ == "__main__":
    main()
