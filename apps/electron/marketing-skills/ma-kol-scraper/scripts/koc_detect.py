#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""KOC 互暖检测（移植自 MediaCrawler tools/koc_detect.py，由 ma-kol-scraper skill 驱动）

三层评分 + 红线否决：
- 第一层(评论者跨达人重合): 权重 60%
- 黑名单命中(历史互暖号):  权重 30%
- 第二层(高频评论者画像验证): 权重 10%
- 模板率: 红线否决项(>20% 直接排除, 不参与互暖分)

每轮检测结束后自动把"画像实锤"(主页有笔记)的嫌疑号合并写回黑名单, 未实锤不进。

用法:
  python3 koc_detect.py --data-dir <数据目录> --blacklist <默认黑名单> [--blacklist-user <本地累积黑名单>] <达人user_id> ...

数据源: <数据目录>/creator_contents_*.jsonl 与 creator_comments_*.jsonl
黑名单: --blacklist 为 skill 默认基线(只读); --blacklist-user 为本地累积版(~/.mapro/koc-blacklist.json),
        评分用二者合并, 检测结果写回本地累积版。未给 --blacklist-user 时降级为单文件读写 --blacklist。
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict

TEMPLATE_REDLINE = 0.20  # 模板率红线: 超过直接判定低质水军
SUSPECT_RATIO_FULL = 0.15  # 嫌疑占比达到 15% 即视为第一层满分
BLACKLIST_HIT_FULL = 5  # 命中黑名单达到 5 人即视为黑名单分满分


def load_blacklist(blacklist_file: str) -> dict:
    """user_id -> hits"""
    if not blacklist_file or not os.path.exists(blacklist_file):
        return {}
    try:
        data = json.load(open(blacklist_file, encoding="utf-8"))
        return {u["user_id"]: u.get("hits", 1) for u in data.get("users", [])}
    except (json.JSONDecodeError, KeyError):
        return {}


def load_blacklist_combined(default_file: str, user_file: str) -> dict:
    """合并 skill 默认版(基线) + 本地累积版, 同一 user 的 hits 累加"""
    combined = dict(load_blacklist(default_file))
    for uid, hits in load_blacklist(user_file).items():
        combined[uid] = combined.get(uid, 0) + hits
    return combined


def save_blacklist(blacklist_file: str, blacklist: dict, new_suspects: list, updated: str):
    """合并本轮新嫌疑号并写回黑名单文件"""
    for uid in new_suspects:
        blacklist[uid] = blacklist.get(uid, 0) + 1
    rows = [{"user_id": uid, "hits": hits, "note": ""}
            for uid, hits in sorted(blacklist.items(), key=lambda x: -x[1])]
    data = {
        "updated": updated,
        "description": "已实锤的互暖群成员(user_id)。仅画像验证通过(主页有笔记)的嫌疑号才会进入；未实锤的自动排除。每轮检测结束后由 koc_detect.py 自动更新。",
        "users": rows,
    }
    with open(blacklist_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"  📝 黑名单已更新: 共 {len(blacklist)} 个互暖号 -> {blacklist_file}")


def hash_of(uid: str) -> str:
    return hashlib.sha256(uid.encode()).hexdigest()[:16]


def norm_text(s: str) -> str:
    """归一化: 去空白/标点/数字/表情, 统一为小写"""
    if not s:
        return ""
    s = re.sub(r"[（(【\[]", "(", s)
    s = re.sub(r"[）)】\]]", ")", s)
    s = re.sub(r"[\s\d\W_]+", "", s.lower())
    return s


def char_ngrams(s: str, n: int = 3) -> set:
    return {s[i:i + n] for i in range(len(s) - n + 1)} if len(s) >= n else {s}


def load_comments(data_dir: str) -> list:
    rows = []
    for f in glob.glob(f"{data_dir}/creator_comments_*.jsonl"):
        for line in open(f, encoding="utf-8"):
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def load_contents(data_dir: str) -> dict:
    """note_id -> creator_hash"""
    note_owner = {}
    for f in glob.glob(f"{data_dir}/creator_contents_*.jsonl"):
        for line in open(f, encoding="utf-8"):
            try:
                d = json.loads(line)
                note_owner[d["note_id"]] = d.get("creator_hash", "")
            except (json.JSONDecodeError, KeyError):
                continue
    return note_owner


def template_rate(comments: list) -> tuple:
    """第三层: 评论模板率。归一化后精确重复 + 近似重复(n-gram Jaccard>=0.8)"""
    if not comments:
        return 0.0, []
    norms = [norm_text(c.get("content", "")) for c in comments]
    total = len([n for n in norms if n])
    if total == 0:
        return 0.0, []

    exact = Counter(n for n in norms if n)
    templated = set()
    # 精确重复
    for n, cnt in exact.items():
        if cnt >= 2:
            templated.add(n)
    # 近似重复: 同长度桶内 n-gram Jaccard
    buckets = defaultdict(list)
    for idx, n in enumerate(norms):
        if n and n not in templated:
            buckets[len(n)].append((idx, n))
    for bucket in buckets.values():
        if len(bucket) > 300:
            continue  # 过大跳过近似，避免 O(n²)
        for i in range(len(bucket)):
            for j in range(i + 1, len(bucket)):
                if bucket[i][1] == bucket[j][1]:
                    continue
                a, b = char_ngrams(bucket[i][1]), char_ngrams(bucket[j][1])
                inter = len(a & b)
                if inter / (len(a | b) or 1) >= 0.8:
                    templated.add(bucket[i][1])
                    templated.add(bucket[j][1])
    rate = len(templated) / total
    samples = [n for n, c in exact.most_common(8) if c >= 2]
    return rate, samples


def main():
    parser = argparse.ArgumentParser(description="KOC 互暖检测")
    parser.add_argument("--data-dir", required=True, help="JSONL 数据目录(含 creator_contents_*.jsonl / creator_comments_*.jsonl)")
    parser.add_argument("--blacklist", required=True, help="skill 默认黑名单路径(随版本分发的基线, 只读)")
    parser.add_argument("--blacklist-user", default="", help="本地累积黑名单路径(~/.mapro/koc-blacklist.json), 检测结果写这里; 提供时与默认版合并用于评分")
    parser.add_argument("--updated", default="", help="黑名单更新时间(YYYY-MM-DD), 默认今天")
    parser.add_argument("creators", nargs="+", help="候选达人 user_id 列表")
    args = parser.parse_args()

    data_dir = os.path.abspath(args.data_dir)
    blacklist_file = args.blacklist
    blacklist_user_file = args.blacklist_user
    # 未提供本地累积版时降级为单文件模式, 读写默认版
    if not blacklist_user_file:
        blacklist_user_file = blacklist_file
    updated = args.updated

    if not os.path.isdir(data_dir):
        print(f"[ERROR] 数据目录不存在: {data_dir}")
        sys.exit(1)

    creators = args.creators
    note_owner = load_contents(data_dir)
    comments = load_comments(data_dir)

    # 每个达人的笔记与评论者 (key 用 creator_hash)
    creators_h = [(u, hash_of(u)) for u in creators]
    creator_notes = {h: set() for _, h in creators_h}
    creator_users = {h: set() for _, h in creators_h}
    creator_comments = {h: [] for _, h in creators_h}
    for c in comments:
        note_id, uid = c.get("note_id"), c.get("user_id")
        if not note_id:
            continue
        owner = note_owner.get(note_id, "")
        if owner in creator_notes:
            creator_notes[owner].add(note_id)
            if uid:
                creator_users[owner].add(uid)
                creator_comments[owner].append(c)

    print("=" * 60)
    print("【第一层】跨达人评论者重合检测")
    print("=" * 60)
    for u, h in creators_h:
        print(f"  {u}: 笔记 {len(creator_notes[h])} 篇, 评论 {len(creator_comments[h])} 条, 评论者 {len(creator_users[h])} 人")

    # 重合矩阵
    n = len(creators_h)
    print()
    print("评论者 Jaccard 重合矩阵 (行/列 = 达人序号):")
    for i in range(n):
        row = []
        for j in range(n):
            if i == j:
                row.append("   —")
            else:
                a, b = creator_users[creators_h[i][1]], creator_users[creators_h[j][1]]
                if not a or not b:
                    row.append(" 0.0%")
                else:
                    row.append(f" {len(a & b) / len(a | b) * 100:4.1f}%")
        print(f"  [{i}] " + " ".join(row))
    for i, (u, _) in enumerate(creators_h):
        print(f"  {i}={u}")

    # 高频评论者 (出现 >=2 个达人)
    freq = Counter()
    for _, h in creators_h:
        freq.update(creator_users[h])
    overlap_users = [(uid, cnt) for uid, cnt in freq.items() if cnt >= 2]
    overlap_users.sort(key=lambda x: -x[1])
    print()
    print(f"出现在 ≥2 个达人评论区的用户(互暖嫌疑): {len(overlap_users)} 人")
    for uid, cnt in overlap_users[:20]:
        print(f"  {uid}  出现于 {cnt} 个达人评论区")

    # 每个达人的"高频嫌疑用户占比"
    suspicious = {u for u, c in overlap_users}
    print()
    print("各达人评论区中嫌疑用户占比(第一层):")
    for u, h in creators_h:
        su = creator_users[h] & suspicious
        total = len(creator_users[h]) or 1
        print(f"  {u}: {len(su)}/{len(creator_users[h])} = {len(su) / total * 100:.1f}%")

    # 第二层: 嫌疑号画像验证 (是否也是 KOC: 主页有笔记)
    print()
    print("=" * 60)
    print("【第二层】高频评论者画像验证")
    print("=" * 60)
    sus_notes = defaultdict(list)
    for f in glob.glob(f"{data_dir}/creator_contents_*.jsonl"):
        for line in open(f, encoding="utf-8"):
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            h = d.get("creator_hash", "")
            for uid in suspicious:
                if h == hash_of(uid):
                    sus_notes[uid].append(d)
    unknown = [u for u in suspicious if u not in sus_notes]
    if unknown:
        print(f"  ⚠️ 以下嫌疑号尚未抓取主页(第二层无数据, 按非KOC处理): {unknown}")
    for uid in sorted(suspicious, key=lambda u: -len(sus_notes[u])):
        notes = sus_notes[uid]
        title = (notes[0].get("title", "") if notes else "【无主页数据】").replace("\n", "")
        print(f"  {uid}: 笔记 {len(notes)} 篇 | {title[:30]}")

    # 互暖风险分 = 60% x 嫌疑占比 + 30% x 黑名单命中 + 10% x 嫌疑号中KOC占比
    print()
    print("=" * 60)
    print("【互暖风险评分】")
    print("=" * 60)
    blacklist = load_blacklist_combined(blacklist_file, blacklist_user_file)
    scores = {}
    for u, h in creators_h:
        su = creator_users[h] & suspicious
        total = len(creator_users[h]) or 1
        ratio = len(su) / total
        layer1 = min(ratio / SUSPECT_RATIO_FULL, 1.0) * 100
        bl_hit = su & set(blacklist)
        layer_bl = min(len(bl_hit) / BLACKLIST_HIT_FULL, 1.0) * 100
        koc_n = len([s for s in su if sus_notes.get(s)])
        conf = min(len(su) / 5.0, 1.0)  # 嫌疑号过少时画像参考意义降低
        layer2 = (koc_n / len(su) * 100 * conf) if su else 0.0
        risk = round(0.6 * layer1 + 0.3 * layer_bl + 0.1 * layer2, 1)
        scores[u] = risk
        print(f"  {u}: 嫌疑 {ratio * 100:.1f}%(分{layer1:.0f}) "
              f"+ 黑名单命中 {len(bl_hit)}人(分{layer_bl:.0f}) "
              f"+ KOC画像 {koc_n}/{len(su)}(分{layer2:.0f}) => 互暖风险 {risk}")

    # 模板率红线 (不参与互暖分, 独立否决)
    print()
    print("=" * 60)
    print("【模板率红线】(>20% 直接排除)")
    print("=" * 60)
    template_flags = {}
    for u, h in creators_h:
        rate, samples = template_rate(creator_comments[h])
        template_flags[u] = rate
        flag = "❌ 低质水军 - 直接排除" if rate > TEMPLATE_REDLINE else "✓ 正常"
        print(f"  {u}: 模板率 {rate * 100:.1f}%  {flag}")
        for s in samples:
            print(f"     重复示例: 「{s}」")

    # 结论
    print()
    print("=" * 60)
    print("【结论】")
    print("=" * 60)
    verdicts = {}
    for u, h in creators_h:
        rate = template_flags[u]
        if rate > TEMPLATE_REDLINE:
            verdict = "排除(评论区疑似低质水军)"
        elif scores[u] >= 60:
            verdict = "排除(互暖高风险)"
        elif scores[u] >= 40:
            verdict = "人工复核(互暖中风险)"
        else:
            verdict = "通过(评论区干净)"
        verdicts[u] = verdict
        print(f"  {u}: 互暖分 {scores[u]} | 模板率 {rate * 100:.1f}% => {verdict}")

    # 更新黑名单: 仅"画像实锤"(主页有笔记)的嫌疑号写回, 防误伤真实粉丝
    # 写入目标为本地累积版(默认版随 skill 分发保持只读基线, 不在此改写以免被版本更新覆盖掉累积数据)
    print()
    verified = [u for u in suspicious if sus_notes.get(u)]
    pending = [u for u in suspicious if not sus_notes.get(u)]
    blacklist = load_blacklist(blacklist_user_file)
    for u in pending:  # 未实锤的旧条目移出黑名单
        blacklist.pop(u, None)
    if pending:
        print(f"  ⚠️ {len(pending)} 个嫌疑号无主页画像数据, 不进黑名单(待验证): {sorted(pending)}")
    save_blacklist(blacklist_user_file, blacklist, verified, updated or "")

    # 输出结构化结果到 stdout (供 mutual_warm_pipeline.py 解析)
    import json as _json
    summary = {"scores": scores, "verdicts": verdicts, "template_rates": template_flags}
    print("\n__KOC_RESULT_JSON__")
    print(_json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
