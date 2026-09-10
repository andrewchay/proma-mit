"""最终清洗（参数化）：删非目标内容 + 竞品/雷区词。

1. 非目标内容清洗：内容标签不含任一目标类目（--categories）时，检查 top8 正文是否含内容信号词（--food-words）；无 → 删除
2. 竞品/雷区词清洗：top8 正文含任一 --guoqie-words → 删除（如水果果切/果切外卖等竞品）

用法: python3 clean_final.py --csv <打分.csv> --out <清洗后.csv> \
       [--categories 美食 生活记录] [--food-words 探店 餐厅 ...] [--guoqie-words 果切 水果切 ...]
"""
import argparse, csv

FOOD_WORDS = ["探店", "餐厅", "火锅", "甜品", "咖啡", "奶茶", "面条", "米饭", "菜", "料理", "餐", "小吃",
              "烧烤", "烘焙", "面包", "蛋糕", "饮品", "食堂", "龙虾", "汤", "粥", "饺子", "粉", "肯德基",
              "麦当劳", "汉堡", "虾堡", "美食", "好吃", "点单", "招牌", "辣", "零食", "团购", "茶", "食物",
              "餐饮", "面馆", "小馆", "烘焙店", "甜品店", "奶茶店", "咖啡店", "食", "水果"]
GUOQIE_WORDS = ["果切", "水果切", "切果", "果切外卖", "削水果", "拼果", "切好的水果", "鲜切水果"]


def main():
    ap = argparse.ArgumentParser(description="最终清洗：删非目标内容 + 竞品/雷区词")
    ap.add_argument("--csv", required=True, help="打分CSV输入（含内容标签/top8标题/正文）")
    ap.add_argument("--out", required=True, help="清洗后CSV输出路径")
    ap.add_argument("--categories", nargs="*", default=["美食"], help="目标内容类目（内容标签含任一则跳过非目标清洗）")
    ap.add_argument("--food-words", nargs="*", default=FOOD_WORDS, help="内容信号判断词（正文含任一即视为有目标内容）")
    ap.add_argument("--guoqie-words", nargs="*", default=GUOQIE_WORDS, help="竞品/雷区词（正文含任一即剔除）")
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.csv, encoding="utf-8-sig")))
    removed = []

    def remove(r, reason):
        r["_drop"] = reason

    for r in rows:
        cat = (r.get("内容标签") or "")
        text = (r.get("top8帖子正文") or "") + (r.get("top8帖子标题") or "")
        # 1) 非目标内容清洗：内容标签不含任一目标类目 → 检查正文有无内容信号
        if not any(c in cat for c in args.categories):
            hits = [w for w in args.food_words if w in text]
            if not hits:
                remove(r, "非目标内容且正文无内容信号")
                continue
        # 2) 竞品/雷区词清洗（如果切等）
        gq = [w for w in args.guoqie_words if w in text]
        if gq:
            remove(r, f"雷区词[{gq[0]}]")

    kept = [r for r in rows if not r.get("_drop")]
    for r in kept:
        r.pop("_drop", None)
    removed_list = [r for r in rows if r.get("_drop")]

    fieldnames = [f for f in rows[0].keys() if f != "_drop"]
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(kept)

    print(f"原 {len(rows)} 人 → 清洗后 {len(kept)} 人，淘汰 {len(removed_list)} 人")
    print("=== 被淘汰名单 ===")
    for r in removed_list:
        print(f"  {r['达人名称']} | {r['_drop']} | 类目[{r.get('内容标签')}]")
    print(f"已输出: {args.out}")


if __name__ == "__main__":
    main()
