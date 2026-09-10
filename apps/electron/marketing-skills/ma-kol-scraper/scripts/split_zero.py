"""拆分最终结果：合作笔记=0 与 合作笔记≥1。
用法: python3 split_zero.py <最终结果.csv> <输出目录>
"""
import csv, sys, os


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    final, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)  # 输出目录不存在时自动创建（v2.5.1 修复：此前直接 open 会抛 FileNotFoundError）
    rows = list(csv.DictReader(open(final, encoding="utf-8-sig")))

    def is_zero(r):
        try:
            return int(float(r.get("合作笔记发布篇数") or 0)) == 0
        except (TypeError, ValueError):
            return True

    zero = [r for r in rows if is_zero(r)]
    nonzero = [r for r in rows if not is_zero(r)]
    fn = list(rows[0].keys())
    base = os.path.splitext(os.path.basename(final))[0]
    for name, group in [(f"{base}_合作笔记0.csv", zero), (f"{base}_合作笔记非0.csv", nonzero)]:
        with open(os.path.join(outdir, name), "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=fn)
            w.writeheader()
            w.writerows(group)
        print(f"{name}: {len(group)} 人")


if __name__ == "__main__":
    main()
