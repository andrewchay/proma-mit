"""阶段2 初筛（参数化：不同 campaign 的筛选条件可配置）。

规则（均可用 --config 或命令行覆盖）：
1. 内容类目命中目标类目 且 主页标签命中目标标签（a AND b 交叉验证）
2. 纯旅游/纯美妆：内容类目不命中任一目标类目才排除
3. 排除词（大学生/宠物/搞笑/知识付费等）标签命中即排除
4. 母婴类：主页标签含精致宝妈才放行
5. 女性粉丝占比 ≥ --female-min
6. 近30天日常+合作篇数和 ≥ --min-notes
7. 粉丝所在区域 top5 命中 --fans-cities
8. 图文或视频报价任一在 [--price-lo, --price-hi]（万）

用法: python3 screen_v2.py --csv 采集结果.csv --out 筛选后.csv \
       [--config config.json] [--female-min 0.70] [--min-notes 4] \
       [--price-lo 0.05 --price-hi 2.0] [--fans-cities 上海 杭州 ...]
"""
import argparse, csv, json, re

# 默认值（未传 --config / 命令行时使用）
DEFAULT_CATEGORIES = ["美食探店", "美食", "生活记录", "家居家装", "家居用品", "时尚", "穿搭", "生活"]
DEFAULT_HOME_TAGS = ["互联网打工人", "精致宝妈", "氛围感", "高级感", "plog", "职场生活", "探店", "ootd", "韩系"]
DEFAULT_EXCLUDE = ["大学生", "宠物", "搞笑", "知识付费", "课程", "培训", "备考", "留学"]
DEFAULT_MATERNAL = ["母婴", "育儿", "孕产", "孕期", "带娃", "辅食", "婴幼儿", "奶爸"]
DEFAULT_PURE = ["旅游", "旅行", "出行", "美妆"]
DEFAULT_FANS_CITIES = ["上海", "杭州", "宁波", "温州", "嘉兴", "湖州", "绍兴", "金华", "衢州", "舟山", "台州", "丽水"]


def parse_content_tags(content_tag_str):
    """'内容标签'列: '美食(美食探店,美食展示);生活记录(接地气生活)' → set of tags"""
    tags = set()
    if not content_tag_str:
        return tags
    for part in content_tag_str.split(";"):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(.+?)\((.*)\)$", part)
        if m:
            tags.add(m.group(1).strip())
            for t2 in m.group(2).split(","):
                t2 = t2.strip()
                if t2:
                    tags.add(t2)
        else:
            tags.add(part)
    return tags


class Rules:
    def __init__(self, args, cfg):
        self.categories = cfg.get("strict_categories") or DEFAULT_CATEGORIES
        self.home_tags = cfg.get("strict_home_tags") or DEFAULT_HOME_TAGS
        self.exclude = cfg.get("strict_exclude_words") or DEFAULT_EXCLUDE
        self.maternal = cfg.get("strict_maternal_words") or DEFAULT_MATERNAL
        self.maternal_pass = cfg.get("strict_maternal_pass") or "精致宝妈"
        self.pure = args.pure_words or cfg.get("strict_pure_words") or DEFAULT_PURE
        self.female_min = args.female_min
        self.min_notes = args.min_notes
        # 报价（万）
        if cfg.get("note_price_lower") is not None:
            self.price_lo = cfg["note_price_lower"] / 10000.0
            self.price_hi = cfg["note_price_upper"] / 10000.0
        else:
            self.price_lo, self.price_hi = args.price_lo, args.price_hi
        self.fans_cities = args.fans_cities or DEFAULT_FANS_CITIES


def check(row, r):
    why = []
    content = parse_content_tags(row.get("内容标签", ""))
    feature = set(t.strip() for t in re.split(r"[;；]", (row.get("擅长标签") or "")) if t.strip())
    all_tags = content | feature

    # 纯旅游/纯美妆：内容类目不命中任一目标类目、命中旅游/美妆才排除
    has_valid_cat = any(any(g in t or t in g for g in r.categories) for t in content)
    if not has_valid_cat:
        for t in content:
            for pw in r.pure:
                if pw in t or t in pw:
                    why.append(f"纯[{pw}]类目")
                    return False, ";".join(why)
    # 其他排除词
    for t in all_tags:
        for ex in r.exclude:
            if ex in t or t in ex:
                why.append(f"排除[{ex}]命中[{t}]")
                return False, ";".join(why)
    # 母婴育儿：主页标签含精致宝妈放行
    is_maternal = any(any(m in t or t in m for m in r.maternal) for t in all_tags)
    if is_maternal and not any(r.maternal_pass in ft for ft in feature):
        why.append("母婴育儿(非精致宝妈)")
        return False, ";".join(why)

    # 内容类目命中（a）
    cat_hit = any(any(g in t or t in g for g in r.categories) for t in content)
    if not cat_hit:
        why.append(f"类目不符[{row.get('内容标签','')[:40]}]")
        return False, ";".join(why)
    # 主页标签命中（b）
    home_hit = any(any(g in t or t in g for g in r.home_tags) for t in feature)
    if not home_hit:
        why.append(f"主页标签不符[{row.get('擅长标签','')[:40]}]")
        return False, ";".join(why)

    # 女性粉丝占比
    try:
        female = float(row.get("女性粉丝占比") or 0)
    except Exception:
        female = 0
    if female < r.female_min:
        why.append(f"女性占比{female:.2f}<{r.female_min:.0%}")
        return False, ";".join(why)

    # 近30天篇数和
    def num(v):
        try:
            return int(float(v or 0))
        except Exception:
            return 0
    if num(row.get("日常笔记发布篇数")) + num(row.get("合作笔记发布篇数")) < r.min_notes:
        why.append(f"篇数和<{r.min_notes}")
        return False, ";".join(why)

    # 粉丝所在区域命中
    fans_cities = (row.get("粉丝所在区域（前五城市）") or "")
    if not fans_cities:
        why.append("粉丝地域缺失")
        return False, ";".join(why)
    if not any(c in fans_cities for c in r.fans_cities):
        why.append(f"粉丝地域不符[{fans_cities[:40]}]")
        return False, ";".join(why)

    # 报价检查：图文或视频报价任一在 [price_lo, price_hi]（万）
    def price_ok(v):
        try:
            return r.price_lo <= float(v) <= r.price_hi
        except (TypeError, ValueError):
            return False
    if not (price_ok(row.get("图文报价（万）")) or price_ok(row.get("视频报价（万）"))):
        why.append(f"报价不符[{row.get('图文报价（万）')}/{row.get('视频报价（万）')}万]")
        return False, ";".join(why)

    # 沪杭笔记判断移到 top-8 阶段复核（主采集无正文）
    return True, ""


def main():
    ap = argparse.ArgumentParser(description="阶段2 初筛（参数化）")
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", default="", help="config JSON（读取 strict_categories/strict_home_tags/报价/粉丝地域等，覆盖默认）")
    ap.add_argument("--female-min", type=float, default=0.70)
    ap.add_argument("--min-notes", type=int, default=4)
    ap.add_argument("--price-lo", type=float, default=0.05, help="报价下限（万）")
    ap.add_argument("--price-hi", type=float, default=2.0, help="报价上限（万）")
    ap.add_argument("--fans-cities", nargs="*", default=[], help="粉丝地域城市列表")
    ap.add_argument("--pure-words", nargs="*", default=[], help="纯旅游/纯美妆排除词（内容类目不命中目标类目、命中这些词才排除）")
    args = ap.parse_args()

    cfg = {}
    if args.config:
        cfg = json.load(open(args.config, encoding="utf-8"))
    rules = Rules(args, cfg)

    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    fieldnames = list(rows[0].keys())
    for col in ("筛选状态", "筛选原因"):
        if col not in fieldnames:
            fieldnames.append(col)

    passed, reasons = [], {}
    for r in rows:
        ok, why = check(r, rules)
        if ok:
            r["筛选状态"] = "通过"
            r["筛选原因"] = ""
            passed.append(r)
        else:
            r["筛选状态"] = "淘汰"
            r["筛选原因"] = why
            reasons[why.split(";")[0]] = reasons.get(why.split(";")[0], 0) + 1

    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(passed)

    print(f"=== 阶段2初筛结果（共 {len(rows)} 人）===")
    print(f"✅ 通过: {len(passed)} 人 -> {args.out}")
    print(f"❌ 淘汰: {len(rows) - len(passed)} 人")
    print("—— 淘汰原因分布 ——")
    for k, v in sorted(reasons.items(), key=lambda x: -x[1]):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
