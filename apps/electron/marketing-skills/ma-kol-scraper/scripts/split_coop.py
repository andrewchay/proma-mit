"""从阶段2筛选后CSV生成 coop 子集（合作笔记≥1），供 top-8 采集。
用法: python3 split_coop.py <采集结果.csv> <筛选后.csv> <输出coop.csv>
"""
import csv, sys


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    all_csv, s2_csv, out = sys.argv[1], sys.argv[2], sys.argv[3]
    all_rows = list(csv.DictReader(open(all_csv, encoding="utf-8-sig")))
    s2 = list(csv.DictReader(open(s2_csv, encoding="utf-8-sig")))
    s2uids = {r.get("userId") for r in s2}

    def coop_n(r):
        try:
            return int(float(r.get("合作笔记发布篇数")))
        except (TypeError, ValueError):
            return 0

    coop = [r for r in all_rows if r.get("userId") in s2uids and coop_n(r) >= 1]
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(all_rows[0].keys()))
        w.writeheader()
        w.writerows(coop)
    print(f"coop 子集(合作≥1): {len(coop)} 人 -> {out}")


if __name__ == "__main__":
    main()
