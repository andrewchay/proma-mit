#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""互暖排查编排（阶段9，ma-kol-scraper skill）

把达人筛选(8阶段)后的最终 CSV 名单，对每个达人做小红书站内互暖排查：
  1. 从清洗后 CSV 提取候选人（默认用「userId」列作为站内 user_id）
  2. 采集：调用 collect_creator_xhs.py 抓笔记+评论 -> JSONL
  3. 检测：调用 koc_detect.py 三层评分 + 红线条
  4. 合并：把互暖分/模板率/结论写回原 CSV -> 输出个互暖排查结果 CSV

ID 关联（兜底方案）：
  - 蒲公英的 userId 不一定是站内 user_id（24 位 hex）。通过 --id-mapping 提供
    「蒲公英 userId -> 站内 user_id」的映射（CSV 或 JSON），否则默认把 userId 列直接当站内 id。
  - 若蒲公英 xiaohongshuId 是站内 user_id，可 --id-column xiaohongshuId 指定列。

依赖：本脚本只做编排，实际采集/检测调用同目录的 collect_creator_xhs.py / koc_detect.py

用法：
  python3 mutual_warm_pipeline.py \
      --csv 最终清洗后.csv \
      --id-column userId \
      --data-dir 工作目录/data \
      --blacklist ../../blacklist.json \
      --cdp-port 9222 \
      --output 互暖排查结果.csv
  可选 --id-mapping mapping.csv|mapping.json  指定蒲公英id->站内id映射
       --user-blacklist ~/.mapro/koc-blacklist.json  本地累积黑名单(默认)
       --max-notes/--max-comments            采集参数

黑名单存储（默认版 + 本地累积版）：
  - skill 的 blacklist.json 作为「出厂默认」基线（随版本分发, 只读）
  - 检测结果累积写入 ~/.mapro/koc-blacklist.json（本地持久, 不被 skill 更新覆盖）
  - 评分时合并两者，取并集命中
"""
import argparse
import csv
import json
import os
import re
import subprocess
import sys
import time
from typing import Optional


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def load_id_mapping(path: str) -> dict:
    """加载映射文件：CSV(两列：蒲公英id,站内id) 或 JSON({蒲公英id: 站内id})"""
    mapping = {}
    if not path or not os.path.exists(path):
        return mapping
    ext = os.path.splitext(path)[1].lower()
    if ext == ".json":
        data = json.load(open(path, encoding="utf-8"))
        mapping = {str(k).strip(): str(v).strip() for k, v in data.items()}
    elif ext == ".csv":
        with open(path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                if not row or not row.get("蒲公英id"):
                    continue
                mapping[row["蒲公英id"].strip()] = (row.get("站内id") or "").strip()
    return mapping


def is_hex_user_id(uid: str) -> bool:
    return bool(uid) and len(uid) == 24 and all(c in "0123456789abcdef" for c in uid)


def read_csv_rows(path: str) -> list:
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        rows = [row for row in reader]
    return header, rows


def write_csv(path: str, header: list, rows: list) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)


def run_cmd(cmd: list, cwd: str = None) -> str:
    """运行命令并返回 stdout"""
    print(f"\n>>> {' '.join(cmd)}")
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd or SCRIPT_DIR)
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr)
        raise RuntimeError(f"命令失败({proc.returncode}): {' '.join(cmd)}")
    return proc.stdout


def parse_koc_result(stdout: str) -> dict:
    """从 koc_detect.py 输出解析 JSON 结果"""
    marker = "__KOC_RESULT_JSON__"
    if marker not in stdout:
        return {}
    payload = stdout.split(marker, 1)[1].strip().split("\n", 1)[0]
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {}


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description="互暖排查编排")
    parser.add_argument("--csv", required=True, help="达人筛选最终 CSV")
    parser.add_argument("--id-column", default="userId", help="CSV 中作为站内 user_id 的列, 默认 userId")
    parser.add_argument("--id-mapping", default="", help="蒲公英id->站内id 映射文件(CSV/JSON), 可选")
    parser.add_argument("--data-dir", required=True, help="JSONL 数据输出目录")
    parser.add_argument("--blacklist", required=True, help="skill 默认黑名单路径(随版本分发的基线, 只读)")
    parser.add_argument("--user-blacklist", default="",
                        help="本地累积黑名单路径, 检测结果写这里并参与评分; 默认为 ~/.mapro/koc-blacklist.json")
    parser.add_argument("--output", required=True, help="互暖排查结果 CSV 输出路径")
    parser.add_argument("--cdp-port", type=int, default=9222)
    parser.add_argument("--max-notes", type=int, default=10)
    parser.add_argument("--max-comments", type=int, default=25)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--collect", default="1", help="是否执行采集(1/0), 场景已有 JSONL 可跳过")
    args = parser.parse_args(argv)

    header, rows = read_csv_rows(args.csv)
    if not rows:
        print("[FAIL] CSV 无数据")
        return 1

    mapping = load_id_mapping(args.id_mapping)
    os.makedirs(args.data_dir, exist_ok=True)

    # 本地累积黑名单: 默认 ~/.mapro/koc-blacklist.json, 并确保目录存在
    user_blacklist = args.user_blacklist.strip()
    if not user_blacklist:
        user_blacklist = os.path.join(os.path.expanduser("~"), ".mapro", "koc-blacklist.json")
    user_blacklist = os.path.abspath(user_blacklist)
    os.makedirs(os.path.dirname(user_blacklist), exist_ok=True)

    # 1. 提取候选人 (蒲公英id -> 站内id)
    candidates = []  # (达人名, 站内id)
    id_col = args.id_column
    if id_col not in header:
        print(f"[FAIL] CSV 中无列「{id_col}」，可用列: {header}")
        return 1
    for row in rows:
        pid = (row.get(id_col) or "").strip()
        if not pid:
            continue
        inner_id = mapping.get(pid, pid)  # 有映射用映射，否则直接当站内id
        candidates.append((row.get("达人名称") or "", inner_id, pid))

    print(f"候选人: {len(candidates)} 位")
    for name, iid, pid in candidates:
        print(f"  {name}: 蒲公英={pid} -> 站内={iid}")
    invalid = [iid for _, iid, _ in candidates if not is_hex_user_id(iid)]
    if invalid:
        print(f"[WARN] {len(invalid)} 个非 24 位 hex 站内 id，可能无法直接采集。"
              f"请用 --id-mapping 提供正确的站内 user_id 映射。示例: {invalid[:3]}")

    # 2. 采集（可跳过）
    if args.collect != "0":
        uid_list = []
        for name, iid, _ in candidates:
            if is_hex_user_id(iid) and iid not in uid_list:
                uid_list.append(iid)
        # 分批次调用，避免单次命令行过长
        BATCH = 20
        for i in range(0, len(uid_list), BATCH):
            batch = uid_list[i:i + BATCH]
            cmd = [
                sys.executable, os.path.join(SCRIPT_DIR, "collect_creator_xhs.py"),
                "--cdp-port", str(args.cdp_port),
                "--max-notes", str(args.max_notes),
                "--max-comments", str(args.max_comments),
                "--interval", str(args.interval),
                "--output-dir", args.data_dir,
            ]
            for uid in batch:
                cmd += ["--user-id", uid]
            run_cmd(cmd)

    # 3. 逐达人检测（koc_detect 需要多个达人才有意义，一次传入全部）
    hex_ids = [iid for _, iid, _ in candidates if is_hex_user_id(iid)]
    if len(hex_ids) < 2:
        print("[WARN] 站内候选人少于 2，互暖第一层(跨达人重合)置信度低")
    cmd = [
        sys.executable, os.path.join(SCRIPT_DIR, "koc_detect.py"),
        "--data-dir", args.data_dir,
        "--blacklist", args.blacklist,
        "--blacklist-user", user_blacklist,
        "--updated", time.strftime("%Y-%m-%d"),
    ] + hex_ids
    stdout = run_cmd(cmd)
    result = parse_koc_result(stdout)
    scores = result.get("scores", {})
    verdicts = result.get("verdicts", {})
    template_rates = result.get("template_rates", {})

    # 4. 合并写回
    out_cols = header + ["互暖分", "模板率", "互暖结论"]
    new_rows = []
    for row in rows:
        pid = (row.get(id_col) or "").strip()
        inner_id = mapping.get(pid, pid)
        new_row = dict(row)
        new_row["互暖分"] = scores.get(inner_id, "")
        new_row["模板率"] = ""
        tr = template_rates.get(inner_id)
        if tr is not None:
            new_row["模板率"] = f"{tr*100:.1f}%"
        new_row["互暖结论"] = verdicts.get(inner_id, "未检测")
        new_rows.append(new_row)

    write_csv(args.output, out_cols, new_rows)
    print(f"\n互暖排查结果已写入: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())