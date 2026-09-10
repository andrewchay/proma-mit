"""给 CSV 增加两列（基于日常笔记近30天仅自然流量的中位数）：
  1. 阅读与点赞占比 = 日常点赞中位数 ÷ 日常阅读中位数
  2. 赞评比 = 日常点赞中位数 ÷ 日常评论中位数
用法: python3 add_ratio_cols.py <csv路径...>
"""
import csv, sys


def process(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        print(f"{path}: 空文件")
        return
    fieldnames = list(rows[0].keys())
    # 插入到"日常笔记评论中位数"之后
    idx = fieldnames.index("日常笔记评论中位数") + 1
    for col in ("阅读与点赞占比", "赞评比"):
        if col not in fieldnames:
            fieldnames.insert(idx, col)
            idx += 1

    for r in rows:
        def num(k):
            try:
                return float(r.get(k) or 0)
            except (TypeError, ValueError):
                return 0
        read = num("日常笔记阅读中位数")
        like = num("日常笔记点赞中位数")
        comment = num("日常笔记评论中位数")
        r["阅读与点赞占比"] = round(like / read, 2) if read else ""
        r["赞评比"] = round(like / comment, 2) if comment else ""

    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    print(f"{path}: 已新增「阅读与点赞占比」「赞评比」2 列，共 {len(rows)} 人")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        process(p)
