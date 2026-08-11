#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kol_screening.py — 达人圈选校验引擎（T2）

消费 ma-kol-scraper 采集产物（CSV + notes_samples JSON），执行四条校验规则，
输出达人评分卡（scorecard）JSON + Markdown，可解释、可复核。

四条校验规则：
  ① 风格校验      抽样笔记文本 → LLM 调性打分（可选 LLM；无 LLM 时用关键词粗评）
  ② 价格带校验    抽样笔记文本/POI/团购信号 → 客单价结构化抽取 → 与价格带规则匹配
  ③ 评论区画像校验 评论样本 → 地理/性别/消费信号聚合（当前用粉丝画像+评论数代理，评论明细可扩展）
  ④ 互动/CPM/CPE  相关类目帖子真实互动数聚合 → 估算 CPM/CPE → 与基准对比打分

用法：
  python3 kol_screening.py \
      --csv <采集结果.csv> \
      --samples <notes_samples.json> \
      --rules <screening_rules.json> \
      --out <scorecard.json> \
      [--llm] [--category 美食探店] [--target-city 上海]

规则全部来自 screening_rules.json（可维护、不写死）。
LLM 能力（可选）：通过环境变量 SCREENING_LLM_URL / SCREENING_LLM_KEY 提供，或直接调用 Proma Cloud。

输出：
  scorecard.json  — 结构化评分卡（各维度分/总分/结论/证据）
  scorecard.md    — 人类可读版本
  scorecard.csv   — 圈选结果表（可复核）
"""

import argparse
import csv
import json
import os
import re
import sys
import urllib.request
from datetime import datetime

# =====================================================================
# 工具函数
# =====================================================================

def safe_float(v, default=0.0):
    try:
        if v is None or v == "":
            return default
        return float(str(v).replace(",", "").replace("万", "0000").replace("亿", "00000000"))
    except Exception:
        return default


def safe_int(v, default=0):
    try:
        if v is None or v == "":
            return default
        return int(float(str(v).replace(",", "")))
    except Exception:
        return default


def clamp(score, lo=0.0, hi=100.0):
    return max(lo, min(hi, score))


# =====================================================================
# 简单 LLM 调用（可选：Proma Cloud / 兼容 OpenAI 接口）
# =====================================================================

class LLMClient:
    def __init__(self, rules_llm=None, enabled=True):
        self.enabled = enabled
        self.rules_llm = rules_llm or {}
        self.base_url = os.environ.get("SCREENING_LLM_URL", "")
        self.api_key = os.environ.get("SCREENING_LLM_KEY", "")

    def chat(self, system_prompt, user_prompt, json_mode=False, max_tokens=1500):
        if not self.enabled or not self.base_url:
            return None
        try:
            payload = {
                "model": os.environ.get("SCREENING_LLM_MODEL", "qwen-plus"),
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.2,
                "max_tokens": max_tokens,
            }
            if json_mode:
                payload["response_format"] = {"type": "json_object"}
            req = urllib.request.Request(
                self.base_url.rstrip("/") + "/chat/completions",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                },
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
        except Exception as e:
            print(f"      [LLM] 调用失败（降级为启发式）: {e}", file=sys.stderr)
            return None

    def extract_json(self, text):
        if not text:
            return None
        try:
            return json.loads(text)
        except Exception:
            m = re.search(r"\{[\s\S]*\}", text)
            if m:
                try:
                    return json.loads(m.group(0))
                except Exception:
                    return None
        return None


# =====================================================================
# 校验 ①：风格校验（LLM 调性打分 / 启发式）
# =====================================================================

STYLE_KEYWORDS_GOOD = ["探店", "测评", "实测", "体验", "开箱", "分享", "打卡", "种草", "真实", "日常",
                       "新鲜", "品质", "健康", "食材", "水果", "鲜切"]
STYLE_KEYWORDS_BAD = ["纯广告", "转发", "抽奖", "优惠券", "复制", "低质", "刷单"]


def validate_style(samples, brand_tone, llm=None, prompt_template=""):
    """① 风格校验：抽样笔记 → 调性打分 0-100。返回 (score, evidence, detail)"""
    texts = [s.get("text") or "" for s in samples]
    titles = [s.get("title") or "" for s in samples]
    corpus = "\n".join(texts + titles)[:6000]

    evidence = []
    if not corpus.strip():
        return 55, "无抽样笔记文本，退回中等分（待人工复核）", {"no_data": True}

    # LLM 优先
    if llm and llm.enabled and llm.base_url:
        user = f"品牌调性画像：{json.dumps(brand_tone, ensure_ascii=False)}\n\n达人抽样笔记：\n{corpus}"
        out = llm.chat(prompt_template or "评估达人内容风格与品牌调性的匹配度，返回 JSON：{\"score\": 0-100, \"reason\": \"...\", \"matched\": [...], \"risks\": [...]}",
                       user, json_mode=True)
        parsed = llm.extract_json(out) if out else None
        if parsed and parsed.get("score") is not None:
            score = clamp(float(parsed["score"]))
            evidence.append(f"LLM 调性打分：{score:.0f}分")
            if parsed.get("reason"):
                evidence.append(str(parsed["reason"]))
            return score, "；".join(evidence), {"llm": True, "matched": parsed.get("matched", []), "risks": parsed.get("risks", [])}

    # 启发式兜底
    good = sum(1 for kw in STYLE_KEYWORDS_GOOD if kw in corpus)
    bad = sum(1 for kw in STYLE_KEYWORDS_BAD if kw in corpus)
    score = clamp(60 + good * 4 - bad * 12)
    evidence.append(f"启发式打分：命中正向关键词 {good} 个 / 负向关键词 {bad} 个")
    evidence.append("（未配置 LLM，建议开启 --llm 提升准确率）")
    return score, "；".join(evidence), {"llm": False, "good_hits": good, "bad_hits": bad}


# =====================================================================
# 校验 ②：价格带校验（客单价抽取 + 规则匹配）
# =====================================================================

PRICE_PATTERNS = [
    re.compile(r"人均\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*元?"),
    re.compile(r"客单价?\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*元?"),
    re.compile(r"[¥￥]\s*(\d+(?:\.\d+)?)\s*元?/人"),
    re.compile(r"团购.*?[¥￥]?\s*(\d+(?:\.\d+)?)\s*元"),
    re.compile(r"套餐.*?[¥￥]?\s*(\d+(?:\.\d+)?)\s*元"),
    re.compile(r"人均消费\s*[¥￥]?\s*(\d+(?:\.\d+)?)"),
    re.compile(r"[¥￥]\s*(\d+(?:\.\d+)?)(?:元)?(?:起|/人|每人)"),
]


def extract_unit_price(samples, llm=None, prompt_template=""):
    """从抽样笔记文本中识别客单价。返回 (price, confidence, evidence, detail)"""
    texts = [s.get("text") or "" for s in samples]
    corpus = "\n".join(texts)[:6000]
    evidence = []

    # LLM 优先
    if llm and llm.enabled and llm.base_url:
        user = f"达人抽样笔记文本：\n{corpus}\n\n识别线下门店客单价/人均消费/套餐价格，返回 JSON：{{\"detected\": true/false, \"price\": 数字, \"confidence\": 0-1, \"evidence\": \"原文片段\"}}"
        out = llm.chat(prompt_template or "你是线下消费价格分析专家。从达人笔记文本中识别门店客单价，只输出 JSON。", user, json_mode=True)
        parsed = llm.extract_json(out) if out else None
        if parsed and parsed.get("detected"):
            price = safe_float(parsed.get("price"), 0)
            if price > 0:
                evidence.append(f"LLM 识别客单价：{price:.0f}元")
                if parsed.get("evidence"):
                    evidence.append(str(parsed["evidence"]))
                return price, float(parsed.get("confidence", 0.7)), "；".join(evidence), {"llm": True}

    # 正则兜底：取多个模式命中的众数/中位
    hits = []
    for pat in PRICE_PATTERNS:
        for m in pat.finditer(corpus):
            p = safe_float(m.group(1), 0)
            if 1 <= p <= 2000:  # 过滤异常值
                hits.append(p)
    if hits:
        hits.sort()
        price = hits[len(hits) // 2]  # 中位数
        evidence.append(f"正则识别客单价：{price:.0f}元（命中 {len(hits)} 处）")
        return price, min(0.85, 0.5 + 0.05 * len(hits)), "；".join(evidence), {"llm": False, "hits": hits}
    return None, 0, "未识别到客单价信息（无人均/价格/团购文本）", {"llm": False, "hits": []}


def match_price_band(price, category_rules, city=""):
    """客单价与价格带规则匹配。返回 (matched, score, detail)"""
    rules = category_rules or {}
    ref_cities = rules.get("reference_cities") or {}
    lo = rules.get("fallback_min")
    hi = rules.get("fallback_max")

    # 城市优先：业务已给该城市参考线
    city_ref = None
    if city:
        for k, v in ref_cities.items():
            if k in city or city in k:
                city_ref = v
                break
    if city_ref is not None:
        lo = city_ref
        hi = rules.get("fallback_max", city_ref * 5)
    if lo is None:
        lo = 0

    if price is None:
        return None, 50, "无价格数据"

    if lo <= price <= (hi or lo * 10):
        return True, 100, f"客单价 {price:.0f} 元 ∈ [{lo:.0f}, {hi or '∞'}]"
    if hi and price <= hi * 1.5 and price >= lo * 0.5:
        return True, 85, f"客单价 {price:.0f} 元，接近价格带边缘（[{lo:.0f}, {hi:.0f}]）"
    if price < lo:
        return False, 40, f"客单价 {price:.0f} 元 < 下限 {lo:.0f} 元（消费力可能不足）"
    return False, 40, f"客单价 {price:.0f} 元 > 上限 {hi:.0f} 元（超出目标价格带）"


# =====================================================================
# 校验 ③：评论区画像校验
# =====================================================================

# 评论用户画像信号词（用于从评论文本/昵称推断地理/性别/消费力）
CITY_KEYWORDS = ["上海", "杭州", "北京", "广州", "深圳", "成都", "苏州", "南京", "宁波", "温州", "本地", "同城"]
GENDER_HINT_MALE = ["哥", "弟", "先生", "大兄弟", "老铁"]
GENDER_HINT_FEMALE = ["姐", "妹", "小姐姐", "集美", "宝妈", "妈妈"]
CONSUME_SIGNALS = ["好吃", "划算", "性价比", "贵", "便宜", "实惠", "回购", "品质", "新鲜", "健康",
                   "带孩子", "带娃", "宝宝", "老公", "老婆", "约会", "闺蜜", "囤货", "复购", "续卡"]
NEGATIVE_SIGNALS = ["踩雷", "不好吃", "坑", "差评", "失望", "太贵", "不值", "滤镜", "假"]


def aggregate_comments(samples):
    """从抽样笔记中聚合评论明细（grab_comments=true 时才有）。
    返回 {users, texts, total, note_count} """
    users, texts, total, note_count = [], [], 0, 0
    for s in samples:
        cmts = s.get("comments") or []
        if not cmts:
            continue
        note_count += 1
        for c in cmts:
            u = (c.get("user") or "").strip()
            t = (c.get("text") or "").strip()
            if u and u not in users:
                users.append(u)
            if t:
                texts.append(t)
            total += 1
    return {"users": users, "texts": texts, "total": total, "note_count": note_count}


def validate_comment_profile(kol_row, samples, target_audience, llm=None, prompt_template=""):
    """③ 评论区画像校验。
    优先消费评论明细（grab_comments=true 采集的评论者昵称+文本），聚合地理/性别/消费信号；
    无评论明细时降级用粉丝画像 + 评论数代理，并在 detail 中标注 degraded=True。
    返回 (score, evidence, detail)"""
    evidence = []
    score = 50.0
    detail = {}

    female_ratio = safe_float(kol_row.get("女性粉丝占比"), 0.5)
    city_str = str(kol_row.get("粉丝所在区域（前五城市）") or "")
    target_cities = target_audience.get("cities") or []
    comment_total = safe_int(kol_row.get("相关帖子评论合计"), 0)

    agg = aggregate_comments(samples)
    users, texts = agg["users"], agg["texts"]
    detail.update({"comment_total": comment_total, "comment_detail_count": agg["total"],
                    "comment_note_count": agg["note_count"], "degraded": agg["total"] == 0})

    # ===== 有评论明细：以评论区画像为主（业务要求：降低粉丝画像权重） =====
    if agg["total"] > 0:
        corpus = "\n".join(texts)[:6000]
        user_corpus = "\n".join(users)[:3000]

        # 地理信号
        hit_cities = [c for c in CITY_KEYWORDS if c in corpus]
        if hit_cities:
            score += 20
            evidence.append(f"评论文本含地域信号：{'/'.join(hit_cities[:6])}")
        else:
            evidence.append("评论文本无显著地域信号（地理维度弱）")

        # 性别信号（昵称+文本启发式）
        male_hits = sum(1 for k in GENDER_HINT_MALE if k in user_corpus or k in corpus)
        female_hits = sum(1 for k in GENDER_HINT_FEMALE if k in user_corpus or k in corpus)
        gender_target = str(target_audience.get("gender") or "").lower()
        if "女性" in gender_target and female_hits > male_hits:
            score += 15
            evidence.append(f"评论昵称/文本女性信号偏多（女 {female_hits} > 男 {male_hits}）")
        elif "女性" in gender_target and male_hits > female_hits:
            score -= 10
            evidence.append(f"评论昵称/文本男性信号偏多（男 {male_hits} > 女 {female_hits}）")
        else:
            evidence.append(f"评论性别信号：女 {female_hits} / 男 {male_hits}（参考）")

        # 消费信号
        consume_hits = [k for k in CONSUME_SIGNALS if k in corpus]
        negative_hits = [k for k in NEGATIVE_SIGNALS if k in corpus]
        if consume_hits:
            score += 15
            evidence.append(f"评论文本含消费信号：{'/'.join(consume_hits[:6])}")
        if negative_hits:
            score -= 12
            evidence.append(f"评论文本含负面信号：{'/'.join(negative_hits[:5])}")

        # LLM 可选：整体画像一致性打分
        if llm and llm.enabled and llm.base_url:
            user = f"品牌目标受众：{json.dumps(target_audience, ensure_ascii=False)}\n评论样本（昵称+文本）：\n" + \
                   "\n".join(f"{u}: {t}" for u, t in zip(users[:30], texts[:30]))
            out = llm.chat(prompt_template or "分析评论用户画像与品牌目标受众的一致性，返回 JSON：{\"score\": 0-100, \"reason\": \"...\"}",
                           user, json_mode=True)
            parsed = llm.extract_json(out) if out else None
            if parsed and parsed.get("score") is not None:
                llm_score = clamp(float(parsed["score"]))
                score = (score + llm_score) / 2
                evidence.append(f"LLM 画像一致性：{llm_score:.0f} 分")

        evidence.append(f"评论明细 {agg['total']} 条 / {agg['note_count']} 篇笔记")
        detail.update({"users": users[:15], "texts": texts[:15]})
        return clamp(score), "；".join(evidence), detail

    # ===== 无评论明细：降级用粉丝画像代理（标注 degraded） =====
    if city_str:
        matched_cities = [c for c in target_cities if c in city_str]
        if matched_cities:
            score += 15
            evidence.append(f"[降级] 粉丝地域含目标城市 {matched_cities}")
        else:
            evidence.append(f"[降级] 粉丝地域 {city_str[:40]} 与目标城市 {target_cities} 匹配度一般")

    gender_target = str(target_audience.get("gender") or "").lower()
    if "女性" in gender_target and female_ratio >= 0.5:
        score += 10
        evidence.append(f"[降级] 女性粉丝占比 {female_ratio:.0%} 符合目标")
    elif female_ratio < 0.4:
        score -= 15
        evidence.append(f"[降级] 女性粉丝占比 {female_ratio:.0%} 偏低")

    if comment_total > 0:
        evidence.append(f"[降级] 抽样相关帖子评论合计 {comment_total} 条，但未采集评论明细（开启 grab_comments=true 后可用评论画像）")
    else:
        evidence.append("[降级] 无评论样本（开启 grab_comments=true 后可用评论画像）")

    return clamp(score), "；".join(evidence), detail


# =====================================================================
# 校验 ④：互动数 / CPM / CPE 估算
# =====================================================================

def validate_engagement(kol_row, samples, eng_rules, price):
    """④ 相关类目帖子真实互动数聚合 → CPM/CPE 估算 → 打分。返回 (score, evidence, detail)"""
    evidence = []
    detail = {}

    sample_imp = safe_int(kol_row.get("相关帖子曝光合计"), 0)
    sample_read = safe_int(kol_row.get("相关帖子阅读合计"), 0)
    sample_like = safe_int(kol_row.get("相关帖子点赞合计"), 0)
    sample_comment = safe_int(kol_row.get("相关帖子评论合计"), 0)
    sample_count = safe_int(kol_row.get("相关帖子抽样数"), len(samples))

    effective_price = safe_float(kol_row.get("图文报价（万）"), 0) * 10000 or \
                      safe_float(kol_row.get("视频报价（万）"), 0) * 10000

    detail.update({
        "sample_count": sample_count,
        "sample_imp": sample_imp,
        "sample_read": sample_read,
        "sample_like": sample_like,
        "sample_comment": sample_comment,
    })

    if sample_count == 0:
        return 50, "无相关帖子抽样数据", detail

    cpm = None
    cpe = None
    if effective_price and sample_imp:
        cpm = effective_price / sample_imp * 1000
        detail["cpm"] = round(cpm, 2)
    if effective_price and sample_like:
        cpe = effective_price / sample_like
        detail["cpe"] = round(cpe, 2)

    if cpm is None and cpe is None:
        return 50, "无法估算 CPM/CPE（缺报价或互动数）", detail

    score = 0.0
    if cpm is not None:
        good = eng_rules.get("cpm", {}).get("good_max", 300)
        ok = eng_rules.get("cpm", {}).get("ok_max", 800)
        if cpm <= good:
            score += 50
            evidence.append(f"CPM {cpm:.0f} 元（优秀 ≤{good}）")
        elif cpm <= ok:
            score += 35
            evidence.append(f"CPM {cpm:.0f} 元（可接受 ≤{ok}）")
        else:
            score += 15
            evidence.append(f"CPM {cpm:.0f} 元（偏高 >{ok}）")
    if cpe is not None:
        good = eng_rules.get("cpe", {}).get("good_max", 5)
        ok = eng_rules.get("cpe", {}).get("ok_max", 15)
        if cpe <= good:
            score += 50
            evidence.append(f"CPE {cpe:.2f} 元（优秀 ≤{good}）")
        elif cpe <= ok:
            score += 35
            evidence.append(f"CPE {cpe:.2f} 元（可接受 ≤{ok}）")
        else:
            score += 15
            evidence.append(f"CPE {cpe:.2f} 元（偏高 >{ok}）")

    return clamp(score), "；".join(evidence), detail


# =====================================================================
# 评分卡聚合
# =====================================================================

def build_scorecard(kol_row, samples, rules, llm=None, category="", city=""):
    """对单个 KOL 执行四条校验，聚合评分卡。返回 dict"""
    brand = rules.get("brand", {})
    rule_rules = rules.get("rules", {})

    # ① 风格
    style_score, style_ev, style_detail = validate_style(
        samples, brand.get("tone_profile", {}), llm,
        prompt_template=rules.get("llm", {}).get("style_tone_prompt", ""),
    )
    # ② 价格带
    price, price_conf, price_ev, price_detail = extract_unit_price(
        samples, llm, prompt_template=rules.get("llm", {}).get("price_extract_prompt", ""),
    )
    cat_rules = rule_rules.get("price_band", {}).get("categories", {}).get(category) or \
                rule_rules.get("price_band", {}).get("categories", {}).get("default", {})
    matched, band_score, band_ev = match_price_band(price, cat_rules, city)
    # ③ 评论区画像
    comment_score, comment_ev, comment_detail = validate_comment_profile(
        kol_row, samples, brand.get("target_audience", {}), llm,
        prompt_template=rules.get("llm", {}).get("comment_profile_prompt", ""),
    )
    # ④ 互动/CPM/CPE
    eng_score, eng_ev, eng_detail = validate_engagement(kol_row, samples, rule_rules.get("engagement_cpm_cpe", {}), price)

    dims = {
        "style_tone": {"score": round(style_score, 1), "evidence": style_ev, "detail": style_detail},
        "price_band": {"score": round(band_score, 1), "evidence": band_ev, "detail": {
            **price_detail, "price": price, "price_confidence": price_conf, "matched": matched}},
        "comment_profile": {"score": round(comment_score, 1), "evidence": comment_ev, "detail": comment_detail},
        "engagement_cpm_cpe": {"score": round(eng_score, 1), "evidence": eng_ev, "detail": eng_detail},
    }

    weights = {
        "style_tone": rule_rules.get("style_tone", {}).get("weight", 0.25),
        "price_band": rule_rules.get("price_band", {}).get("weight", 0.30),
        "comment_profile": rule_rules.get("comment_profile", {}).get("weight", 0.20),
        "engagement_cpm_cpe": rule_rules.get("engagement_cpm_cpe", {}).get("weight", 0.25),
    }
    total = sum(weights.values()) or 1.0
    overall = sum(dims[k]["score"] * weights[k] for k in dims) / total
    overall = clamp(overall)

    # 结论
    pass_th = rules.get("scorecard", {}).get("pass_threshold", 80)
    review_th = rules.get("scorecard", {}).get("review_threshold", 60)
    if overall >= pass_th:
        conclusion = rules.get("scorecard", {}).get("conclusions", {}).get("pass", "通过")
    elif overall >= review_th:
        conclusion = rules.get("scorecard", {}).get("conclusions", {}).get("review", "待复核")
    else:
        conclusion = rules.get("scorecard", {}).get("conclusions", {}).get("reject", "拒绝")

    return {
        "达人名称": kol_row.get("达人名称") or "",
        "userId": kol_row.get("userId") or kol_row.get("小红书号") or "",
        "platform": "小红书",
        "category": category,
        "city": city,
        "overall_score": round(overall, 1),
        "conclusion": conclusion,
        "dimensions": dims,
        "weights": weights,
        "rule_version": rules.get("version", ""),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }


def format_markdown(sc):
    """评分卡 → Markdown 人类可读版"""
    lines = []
    lines.append(f"# 达人评分卡：{sc['达人名称']}")
    lines.append("")
    lines.append(f"- **总分**：{sc['overall_score']} / 100")
    lines.append(f"- **结论**：**{sc['conclusion']}**")
    lines.append(f"- **类目**：{sc['category'] or '未指定'} ｜ **城市**：{sc['city'] or '未指定'}")
    lines.append(f"- **规则版本**：{sc['rule_version']} ｜ 生成时间：{sc['generated_at']}")
    lines.append("")
    lines.append("## 四维校验")
    lines.append("")
    lines.append("| 维度 | 权重 | 得分 | 证据 |")
    lines.append("|------|------|------|------|")
    for k, meta in [("style_tone", "① 风格校验"), ("price_band", "② 价格带校验"),
                    ("comment_profile", "③ 评论区画像"), ("engagement_cpm_cpe", "④ 互动/CPM/CPE")]:
        d = sc["dimensions"][k]
        lines.append(f"| {meta} | {sc['weights'].get(k, 0):.0%} | {d['score']} | {d['evidence']} |")
    lines.append("")
    if sc["dimensions"]["price_band"]["detail"].get("price"):
        p = sc["dimensions"]["price_band"]["detail"]
        lines.append(f"**价格带详情**：识别客单价 {p['price']} 元（置信度 {p['price_confidence']:.0%}），匹配价格带：{'是' if p['matched'] else '否'}")
        lines.append("")
    eng = sc["dimensions"]["engagement_cpm_cpe"]["detail"]
    if eng.get("cpm") is not None or eng.get("cpe") is not None:
        lines.append(f"**互动效率**：相关帖子抽样 {eng.get('sample_count', 0)} 篇，曝光合计 {eng.get('sample_imp', 0)}，"
                     f"CPM={eng.get('cpm', 'N/A')} 元，CPE={eng.get('cpe', 'N/A')} 元")
        lines.append("")
    cmt = sc["dimensions"]["comment_profile"]["detail"]
    if cmt.get("comment_detail_count", 0) > 0:
        lines.append(f"**评论画像**：评论明细 {cmt['comment_detail_count']} 条 / {cmt.get('comment_note_count', 0)} 篇笔记（非降级）")
        if cmt.get("users"):
            lines.append(f"- 评论用户样本：{'、'.join(cmt['users'][:10])}")
        if cmt.get("texts"):
            lines.append(f"- 评论文本样本：{'；'.join(cmt['texts'][:5])}")
        lines.append("")
    return "\n".join(lines)


# =====================================================================
# 主流程
# =====================================================================

def load_samples(path):
    if not path or not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("kols", []) if isinstance(data, dict) else data


def load_rules(path):
    if not path or not os.path.exists(path):
        print("[WARN] 规则配置不存在，使用内置默认", file=sys.stderr)
        return {"version": "default", "brand": {}, "rules": {}, "scorecard": {}}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser(description="达人圈选校验引擎（T2）")
    parser.add_argument("--csv", required=True, help="ma-kol-scraper 采集结果 CSV")
    parser.add_argument("--samples", default="", help="notes_samples.json（可选）")
    parser.add_argument("--rules", default="", help="screening_rules.json（可选，默认同目录）")
    parser.add_argument("--out", default="", help="输出 scorecard.json 路径（可选）")
    parser.add_argument("--category", default="", help="价格带校验类目（如 美食探店/咖啡/水果生鲜）")
    parser.add_argument("--city", default="", help="目标城市（如 上海/杭州）")
    parser.add_argument("--llm", action="store_true", help="启用 LLM 校验（需 SCREENING_LLM_URL/KEY）")
    parser.add_argument("--only", default="", help="只处理指定 userId（逗号分隔，可选）")
    parser.add_argument("--db", default="", help="可选：写入 KOL 数据库 SQLite（kol_performance 表）")
    parser.add_argument("--campaign-id", default="", help="写入 --db 时关联的 campaign_id（可选）")
    args = parser.parse_args()

    default_rules = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "screening_rules.json")
    rules_path = args.rules or default_rules
    rules = load_rules(rules_path)

    llm = LLMClient(rules.get("llm", {}), enabled=args.llm)

    # 读 CSV
    rows = []
    with open(args.csv, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if any(v not in (None, "") for v in row.values()):
                rows.append(row)
    if not rows:
        print("CSV 无数据行")
        return 1

    # 读抽样笔记（按 userId 索引）
    samples_by_user = {}
    for ks in load_samples(args.samples):
        uid = ks.get("userId") or ""
        if uid:
            samples_by_user[uid] = ks.get("samples") or []

    only_ids = set(x.strip() for x in args.only.split(",")) if args.only else set()

    results = []
    for row in rows:
        uid = row.get("userId") or row.get("小红书号") or ""
        if only_ids and uid and uid not in only_ids:
            continue
        samples = samples_by_user.get(uid, [])
        sc = build_scorecard(row, samples, rules, llm, category=args.category, city=args.city)
        results.append(sc)
        print(f"  {sc['达人名称']}: {sc['overall_score']} 分 → {sc['conclusion']}")

    # 输出
    out_path = args.out or (args.csv.replace(".csv", "_scorecard.json"))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"generated_at": datetime.now().isoformat(timespec="seconds"),
                   "rules_version": rules.get("version", ""),
                   "count": len(results),
                   "scorecards": results}, f, ensure_ascii=False, indent=2)
    md_path = out_path.replace(".json", ".md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n\n---\n\n".join(format_markdown(sc) for sc in results))
    csv_path = out_path.replace(".json", ".csv")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["达人名称", "userId", "category", "city",
                                               "overall_score", "conclusion",
                                               "style_tone", "price_band", "comment_profile", "engagement_cpm_cpe"])
        writer.writeheader()
        for sc in results:
            writer.writerow({
                "达人名称": sc["达人名称"], "userId": sc["userId"],
                "category": sc["category"], "city": sc["city"],
                "overall_score": sc["overall_score"], "conclusion": sc["conclusion"],
                "style_tone": sc["dimensions"]["style_tone"]["score"],
                "price_band": sc["dimensions"]["price_band"]["score"],
                "comment_profile": sc["dimensions"]["comment_profile"]["score"],
                "engagement_cpm_cpe": sc["dimensions"]["engagement_cpm_cpe"]["score"],
            })

    print(f"\n完成：{len(results)} 个 KOL 已生成评分卡")
    print(f"  JSON: {out_path}")
    print(f"  MD:   {md_path}")
    print(f"  CSV:  {csv_path}")

    # 可选：写入 KOL 数据库 kol_performance 表（可复核、可追踪）
    if args.db:
        write_db = write_scorecards_to_db(results, args.db, campaign_id=args.campaign_id)
        print(f"  DB:   {write_db}")
    return 0


def write_scorecards_to_db(scorecards, db_path, campaign_id=""):
    """把评分卡写入 SQLite 的 kol_performance 表（若表结构匹配）。
    字段映射：kol_id→userId, category→类目, exposure→相关帖子曝光合计, cpm/cpe→估算值,
    cooperation_score→overall_score。不存在该表时自动建表（宽松结构）。"""
    import sqlite3 as _sqlite3
    try:
        conn = _sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("""CREATE TABLE IF NOT EXISTS kol_performance (
            record_id TEXT PRIMARY KEY,
            kol_id TEXT, campaign_id TEXT, platform TEXT, category TEXT,
            exposure INTEGER, engagement INTEGER, conversion REAL,
            cpm REAL, cpe REAL, roi REAL, cooperation_score REAL,
            record_date TEXT, created_at TEXT
        )""")
        now = datetime.now().isoformat(timespec="seconds")
        for sc in scorecards:
            eng = sc["dimensions"]["engagement_cpm_cpe"]["detail"]
            record_id = f"screen_{sc['userId']}_{now}"
            cur.execute(
                "INSERT OR REPLACE INTO kol_performance "
                "(record_id, kol_id, campaign_id, platform, category, exposure, engagement, conversion, "
                " cpm, cpe, roi, cooperation_score, record_date, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (record_id, sc["userId"], campaign_id, sc["platform"], sc["category"],
                 eng.get("sample_imp", 0), eng.get("sample_like", 0), None,
                 eng.get("cpm"), eng.get("cpe"), None, sc["overall_score"],
                 now, now),
            )
        conn.commit()
        conn.close()
        return f"{len(scorecards)} 条写入 {db_path}"
    except Exception as e:
        return f"写入失败: {e}"


if __name__ == "__main__":
    sys.exit(main())
