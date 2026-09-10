"""对合作笔记非0的达人打分（满分100），按总分降序输出精简名单。

维度：
1. CPE（满分50）：>20→0；15~20→20；10~15→30；5~10→40；0~5→50
2. 点赞率 = 日常点赞中位数 ÷ 日常阅读中位数（近30日仅自然流量，与健康筛选/CSV「阅读与点赞占比」列同口径；满分20）：2%~10%→20，其他→0
3. 赞评比 = 日常点赞中位数 ÷ 日常评论中位数（满分20）：≤5→20；5~8→12；>8→0
4. 爆文率（满分10）：粉丝<1万 且 日常互动中位数≥500 →10；粉丝≥1万 且 日常互动中位数≥1000 →10；否则0

用法: python3 score_kols.py --csv <合作笔记非0.csv> --out <打分.csv>
"""
import argparse, csv

SCORE_COLS = ["CPE得分", "点赞率得分", "赞评比得分", "爆文率得分", "总分"]

# 最终输出表头：33 列（与「最终结果_合作笔记非0.csv」一致：estimate 31 列 + add_ratio 2 列）
# + 打分 5 列 = 38 列；若改用其他打分方式（如 kol_screening.py LLM 校验），替换末尾 5 列即可
TARGET_COLS = [
    "达人名称", "小红书号", "内容类目", "地域", "粉丝量",
    "粉丝所在区域（前五城市）", "获赞与收藏",
    "图文报价（万）", "视频报价（万）", "女性粉丝占比",
    "日常笔记发布篇数", "日常笔记曝光中位数", "日常笔记阅读中位数", "日常笔记点赞中位数",
    "日常笔记互动中位数", "日常笔记评论中位数",
    "阅读与点赞占比", "赞评比",
    "合作笔记发布篇数", "合作笔记曝光中位数", "合作笔记阅读中位数", "合作笔记点赞中位数",
    "合作笔记互动中位数", "合作笔记评论中位数",
    "内容标签", "擅长标签",
    "预估最低曝光", "预估最低点赞",
    "预估CPM", "预估CPE",
    "top8帖子标题", "top8帖子正文", "数据来源",
] + SCORE_COLS


def cpe_score(cpe):
    if cpe > 20:
        return 0
    if cpe >= 15:
        return 20
    if cpe >= 10:
        return 30
    if cpe >= 5:
        return 40
    return 50


def like_rate_score(rate):
    pct = rate * 100
    return 20 if 2 <= pct <= 10 else 0


def zanbi_score(zb):
    if zb <= 5:
        return 20
    if zb <= 8:
        return 12
    return 0


def baowen_score(fans, interact):
    if fans < 10000:
        return 10 if interact >= 500 else 0
    return 10 if interact >= 1000 else 0


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def main():
    ap = argparse.ArgumentParser(description="4 维度确定性打分（满分100）")
    ap.add_argument("--csv", required=True, help="合作笔记非0的CSV（含预估CPE/日常中位数/粉丝量）")
    ap.add_argument("--out", required=True, help="打分结果CSV输出路径")
    args = ap.parse_args()

    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        print(f"输入 CSV 为空: {args.csv}")
        return

    for r in rows:
        cpe = num(r.get("预估CPE"))
        read = num(r.get("日常笔记阅读中位数"))
        like = num(r.get("日常笔记点赞中位数"))
        comment = num(r.get("日常笔记评论中位数"))
        interact = num(r.get("日常笔记互动中位数"))
        fans = num(r.get("粉丝量"))

        s1 = cpe_score(cpe)
        s2 = like_rate_score(like / read) if read else 0
        s3 = zanbi_score(like / comment) if comment else 0
        s4 = baowen_score(fans, interact)
        total = s1 + s2 + s3 + s4
        r["CPE得分"] = s1
        r["点赞率得分"] = s2
        r["赞评比得分"] = s3
        r["爆文率得分"] = s4
        r["总分"] = total

    rows.sort(key=lambda r: r["总分"], reverse=True)  # 降序（最高分在前）

    # 只输出目标 38 列（缺失列补空，避免把 userId 等中间列带进最终名单）
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=TARGET_COLS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({col: r.get(col, "") for col in TARGET_COLS})

    print(f"已输出 {args.out}，共 {len(rows)} 人，按总分降序（最高分在前）")
    from collections import Counter
    dist = Counter(r["总分"] for r in rows)
    print("总分分布:", dict(sorted(dist.items())))


if __name__ == "__main__":
    main()
