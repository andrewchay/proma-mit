"""阶段3 健康筛选：删点赞率不健康的达人。

点赞率 = 日常笔记点赞中位数 ÷ 日常笔记阅读中位数（近30日仅自然流量，与打分 / CSV「阅读与点赞占比」列同口径）。
保留点赞率在 [--lo%, --hi%] 内的达人（默认 1.6%~12%，即 2%~10% 健康区间 ±20% 容差），否则淘汰。

用法: python3 filter_health.py --csv <输入.csv> --out <健康.csv> [--lo 1.6 --hi 12]
"""
import argparse, csv


def main():
    ap = argparse.ArgumentParser(description="删点赞率不健康的达人（日常笔记口径）")
    ap.add_argument("--csv", required=True, help="输入CSV（含日常笔记点赞/阅读中位数）")
    ap.add_argument("--out", required=True, help="健康筛选后CSV输出")
    ap.add_argument("--lo", type=float, default=1.6, help="点赞率下限%（默认1.6）")
    ap.add_argument("--hi", type=float, default=12.0, help="点赞率上限%（默认12）")
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.csv, encoding="utf-8-sig")))
    kept, dropped = [], []
    for r in rows:
        try:
            like = float(r.get("日常笔记点赞中位数") or 0)
            read = float(r.get("日常笔记阅读中位数") or 0)
        except (TypeError, ValueError):
            like = read = 0
        if read <= 0:
            dropped.append((r.get("达人名称") or "", "阅读中位数为0"))
            continue
        rate = like / read * 100
        if args.lo <= rate <= args.hi:
            kept.append(r)
        else:
            dropped.append((r.get("达人名称") or "", f"{rate:.2f}%"))

    fn = list(rows[0].keys())
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fn)
        w.writeheader()
        w.writerows(kept)

    print(f"输入名单 {len(rows)} → 保留 {len(kept)}（点赞率 {args.lo}%~{args.hi}%），淘汰 {len(dropped)}")
    print("淘汰名单(前30):")
    for name, reason in dropped[:30]:
        print(f"  {name}: {reason}")
    print(f"已输出: {args.out}")


if __name__ == "__main__":
    main()
