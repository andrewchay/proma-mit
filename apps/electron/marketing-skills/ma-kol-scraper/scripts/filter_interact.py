"""删除「合作笔记互动中位数」< 阈值 的行（基于主采集数据，无需 top-8）。
用法: python3 filter_interact.py <输入csv> <输出csv> [阈值=100]
"""
import csv, sys


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    inp, out = sys.argv[1], sys.argv[2]
    thr = float(sys.argv[3]) if len(sys.argv) > 3 else 100.0
    rows = list(csv.DictReader(open(inp, encoding="utf-8-sig")))
    kept, dropped = [], 0
    for r in rows:
        v = r.get("合作笔记互动中位数")
        try:
            if float(v) < thr:
                dropped += 1
                continue
        except (TypeError, ValueError):
            pass  # 空值保留
        kept.append(r)
    fn = list(rows[0].keys())
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fn)
        w.writeheader()
        w.writerows(kept)
    print(f"删除互动<{thr}: {dropped} 人，保留 {len(kept)} 人 -> {out}")


if __name__ == "__main__":
    main()
