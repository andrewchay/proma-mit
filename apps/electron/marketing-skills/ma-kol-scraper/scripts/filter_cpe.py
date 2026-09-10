#!/usr/bin/env python3
"""CPE 硬性条件过滤（打分前一步，v2.5）。

业务硬性条件：去掉预估CPE > 阈值（默认 50）的达人，不满足直接淘汰。
阈值用 --max-cpe 配置；后续若有其他硬性条件，沿用本脚本参数化扩展。

用法：
  python3 filter_cpe.py --csv 合作笔记非0.csv --out 打分输入.csv [--max-cpe 50]
"""
import argparse
import csv
import sys


def parse_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser(description="CPE 硬性条件过滤（打分前）")
    ap.add_argument("--csv", required=True, help="输入 CSV（须含预估CPE 列，如合作笔记非0.csv）")
    ap.add_argument("--out", required=True, help="输出 CSV")
    ap.add_argument("--max-cpe", type=float, default=50.0, help="CPE 硬性上限，超过即淘汰（默认 50）")
    ap.add_argument("--col", default="预估CPE", help="CPE 列名（默认 预估CPE）")
    args = ap.parse_args()

    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)

    if not fieldnames or args.col not in fieldnames:
        print(f"[filter_cpe] 未找到列 '{args.col}'，退出（现有列: {fieldnames}）")
        sys.exit(2)

    kept, dropped = [], []
    for r in rows:
        val = parse_float(r.get(args.col))
        if val is not None and val > args.max_cpe:
            dropped.append(r)
        else:
            kept.append(r)

    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(kept)

    print(f"[filter_cpe] 输入={len(rows)} 去掉CPE>{args.max_cpe:g}={len(dropped)} 保留={len(kept)} -> {args.out}")
    for r in dropped[:5]:
        print(f"  去掉: {r.get('达人名称', '')} 预估CPE={r.get(args.col)}")


if __name__ == "__main__":
    main()
