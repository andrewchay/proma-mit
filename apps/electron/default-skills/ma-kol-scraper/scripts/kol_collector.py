#!/usr/bin/env python3
"""小红书蒲公英 KOL 通用采集器（参数化，由 ma-kol-scraper skill 驱动）

版本：v2.0.3（2026-08-02）
  - v2.0.3：修复最低曝光/最低点赞/CPM/CPE 计算——抽屉 ex() 支持同行/换行两种布局 + 万/千单位；互动字段 API 优先、抽屉兜底；0 点赞不再被跳过
  - v2.0.2：末尾合并写入防丢数据；网络中断(net::ERR_*)纳入自动重连；userId 独立列+csv 模块解析断点
  - v2.0.1：location 省市区 token 匹配；搜索阶段同时检查 featureTags；CDP 断线自动重连；断点续采

核心设计（v2）：不再按 campaign 生成独立脚本，所有筛选条件通过 --config JSON 传入，
由 Agent 自动执行；本文件是唯一入口脚本。

原理：
  - 通过 playwright.connect_over_cdp 连接到用户正在使用的真实 Chrome 浏览器
  - 搜索 API 通过 page.evaluate() 在浏览器 JS 上下文中用 fetch() 执行，
    前端代码自动附带正确的 x-s / x-t 签名参数
  - 详情页数据通过导航到 KOL 详情页 + on("response") 监听捕获

用法：
  1. 启动 Chrome 远程调试端口：--remote-debugging-port=9222
  2. 在 Chrome 中登录小红书蒲公英（https://pgy.xiaohongshu.com）
  3. 检查环境：python3 kol_collector.py --check --port 9222
  4. 采集：    python3 kol_collector.py --config <config.json>

config JSON 字段：
  brand_user_id / keywords / gender / location_cities / fans_location_cities
  target_cities / target_tags / trade_type / note_price_lower / note_price_upper
  fans_number_lower / fans_number_upper / first_industry / second_industry
  cdp_port / max_pages / max_kols / coop_note_months / coop_note_pages_max
  output_file / active_within_days

输出：
  CSV（含报价/阅读互动中位数/合作笔记最低数据/CPM/CPE）+ _debug.json
"""

import csv
import datetime
import json
import os
import sys
import time
import uuid
import argparse
import traceback

import playwright.sync_api

WORKDIR = os.path.dirname(os.path.abspath(__file__))

# ========== 接口地址 ==========
SEARCH_API = "https://pgy.xiaohongshu.com/api/solar/cooperator/blogger/v2"
NOTES_RATE_API = "https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate"
NOTES_DETAIL_API = "https://pgy.xiaohongshu.com/api/solar/kol/data_v2/notes_detail"
FANS_PROFILE_API_TPL = "https://pgy.xiaohongshu.com/api/solar/kol/data/{userId}/fans_profile"
CONTENT_TAGS_API = "https://pgy.xiaohongshu.com/api/solar/kol/data_v2/kol_content_tags"
FEATURE_TAGS_API = "https://pgy.xiaohongshu.com/api/solar/kol/data_v2/kol_feature_tags"
BLOGGER_API_TPL = "https://pgy.xiaohongshu.com/api/solar/cooperator/user/blogger/{userId}"

# ========== CSV 表头 ==========
HEADERS = [
    "达人名称", "小红书号", "内容类目", "地域", "粉丝量",
    "粉丝所在区域（前五城市）", "获赞与收藏",
    "图文报价（万）", "视频报价（万）", "女性粉丝占比",
    "日常笔记发布篇数", "日常笔记曝光中位数", "日常笔记阅读中位数", "日常笔记点赞中位数",
    "合作笔记发布篇数", "合作笔记曝光中位数", "合作笔记阅读中位数", "合作笔记点赞中位数",
    "合作笔记最低曝光", "合作笔记最低曝光阅读", "合作笔记最低曝光点赞",
    "合作笔记最低曝光收藏", "合作笔记最低曝光评论", "合作笔记最低曝光时间",
    "合作笔记最低点赞", "合作笔记最低点赞阅读", "合作笔记最低点赞收藏",
    "合作笔记最低点赞评论", "合作笔记最低点赞时间",
    "内容标签", "擅长标签",
    "预估CPM", "预估CPE",
    # ---- v2.1 新增：相关帖子抽样与内容信号 ----
    "相关帖子抽样数", "相关帖子标题", "相关帖子正文片段",
    "相关帖子POI/团购信号", "相关帖子评论数",
    "相关帖子曝光合计", "相关帖子阅读合计", "相关帖子点赞合计", "相关帖子评论合计",
    # ---- v2.2 新增：评论明细（grab_comments=true 时） ----
    "评论样本用户", "评论样本文本",
    "userId", "数据来源",
]

# ========== 辅助函数 ==========


def safe_get(obj, *keys, default=None):
    for key in keys:
        if not isinstance(obj, dict):
            return default
        obj = obj.get(key, default)
    return obj


def format_content_tags(content_tags):
    if not content_tags:
        return ""
    parts = []
    for tag in content_tags:
        if not isinstance(tag, dict):
            parts.append(str(tag))
            continue
        t1 = tag.get("taxonomy1Tag", "") or tag.get("name", "")
        t2s = tag.get("taxonomy2Tags", []) or []
        if t1 and t2s:
            parts.append(f"{t1}({','.join(str(x) for x in t2s)})")
        elif t1:
            parts.append(t1)
    return ";".join(parts)


def format_location_cities(cities):
    """蒲公英搜索 API 的 location/fansLocation 传纯城市名即可。
    实测："中国 上海" 前缀会削弱过滤（混入外地博主），纯 "上海" 过滤 100% 命中。"""
    return [c for c in (cities or []) if c]


def parse_publish_time(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        if ts > 1e12:
            ts /= 1000
        if ts > 1e9:
            return datetime.datetime.fromtimestamp(ts)
    if isinstance(ts, str):
        # 直接对完整字符串 strptime；不要再按 len(fmt) 切片（%Y 占 2 字符会导致截断错误）
        for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d", "%Y/%m/%d %H:%M:%S"):
            try:
                return datetime.datetime.strptime(ts, fmt)
            except Exception:
                continue
    return None


def js_fetch_json(url, method="GET", body=None):
    """在浏览器上下文中用 fetch 发送请求，返回 JSON 结果。
    浏览器侧前端代码会自动计算并附上 x-s, x-t 等签名参数。
    """
    if method == "GET":
        return f"""fetch("{url}", {{
    method: "GET",
    credentials: "include",
    headers: {{ "Accept": "application/json" }}
}}).then(r => {{
    if (r.ok) return r.json();
    return r.text().then(t => {{ throw new Error(`HTTP ${{r.status}}: ${{t.slice(0,200)}}`) }});
}})"""
    else:
        body_str = json.dumps(body, ensure_ascii=False)
        return f"""fetch("{url}", {{
    method: "POST",
    credentials: "include",
    headers: {{ "Content-Type": "application/json", "Accept": "application/json" }},
    body: JSON.stringify({body_str})
}}).then(r => {{
    if (r.ok) return r.json();
    return r.text().then(t => {{ throw new Error(`HTTP ${{r.status}}: ${{t.slice(0,200)}}`) }});
}})"""


# ========== 采集器主类 ==========

class KolCollector:
    """小红书蒲公英 KOL 通用采集器（参数全部来自 config JSON）"""

    def __init__(self, cfg):
        self.cfg = cfg
        self.brand_user_id = cfg.get("brand_user_id", "")
        self.keywords = cfg.get("keywords", []) or []
        self.gender = cfg.get("gender", "不限")
        self.location_cities = format_location_cities(cfg.get("location_cities", []))
        self.fans_location_cities = format_location_cities(cfg.get("fans_location_cities", []))
        self.target_cities = set(cfg.get("target_cities", []))
        self.target_tags = set(cfg.get("target_tags", []))  # 空集合=不做内容标签过滤
        self.trade_type = cfg.get("trade_type", "不限")
        self.price_lower = cfg.get("note_price_lower", 0)
        self.price_upper = cfg.get("note_price_upper", 100000)
        self.fans_lower = cfg.get("fans_number_lower", 0)
        self.fans_upper = cfg.get("fans_number_upper", 500000)
        self.first_industry = cfg.get("first_industry", "")
        self.second_industry = cfg.get("second_industry", "")
        self.cdp_port = cfg.get("cdp_port", 9222)
        self.max_pages = cfg.get("max_pages", 20)
        self.max_kols = cfg.get("max_kols", 0)
        self.coop_note_months = cfg.get("coop_note_months", 3)
        self.coop_note_pages_max = cfg.get("coop_note_pages_max", 10)
        self.active_within_days = cfg.get("active_within_days", 15)
        self.output_file = cfg.get("output_file", "")
        # ---- v2.1 新增配置：相关帖子抽样与内容信号 ----
        self.sample_note_count = cfg.get("sample_note_count", 5)      # 每个 KOL 抽取相关帖子数量
        self.relevance_keywords = cfg.get("relevance_keywords", [])   # 相关性关键词（如水果→食品/饮料）
        self.grab_note_text = cfg.get("grab_note_text", True)         # 是否抓抽屉内笔记正文文本
        self.grab_comments = cfg.get("grab_comments", True)          # 是否抓评论样本（默认开启，成本约每篇+1-2s；设为 false 可提速）
        self.notes_samples_file = cfg.get("notes_samples_file", "")  # 抽样笔记 JSON 输出路径（可选）
        # ---- v2.0.3 新增：强制重采指定 userId（修复历史数据时只重跑异常达人） ----
        self.force_redownload_ids = set(cfg.get("force_redownload_ids", []) or [])

    # ----- 过滤方法 -----

    def kol_matches_location(self, kol):
        if not self.target_cities:
            return True
        loc = (kol.get("location") or "").strip()
        # location 可能是纯城市名（"上海"）或省市区格式（"浙江 杭州 上城区"），
        # 按空格拆分 token 后任一命中即匹配（v2.0.1 修复：startswith 会把杭州 KOL 误滤掉）
        loc_tokens = [t for t in loc.replace("，", " ").split() if t]
        for city in self.target_cities:
            for tok in loc_tokens:
                if tok == city or tok.startswith(city) or city.startswith(tok):
                    return True
            if loc == city or loc.startswith(city):
                return True
        travel = kol.get("travelAreaList") or []
        if isinstance(travel, list):
            for area in travel:
                if isinstance(area, str):
                    for city in self.target_cities:
                        if city in area:
                            return True
        return False

    def kol_matches_price(self, kol):
        for price in (kol.get("picturePrice"), kol.get("videoPrice")):
            if price is None:
                continue
            if self.price_lower <= price <= self.price_upper:
                return True
        return False

    def kol_matches_fans(self, kol):
        fans = kol.get("fansCount") or kol.get("fansNum") or 0
        return self.fans_lower <= fans <= self.fans_upper

    def _tag_values(self, items):
        """把混合 str / dict 的标签列表扁平化为字符串集合（dict 取 name / tagName / taxonomy1Tag）"""
        out = set()
        for it in (items or []):
            if isinstance(it, str):
                if it:
                    out.add(it)
            elif isinstance(it, dict):
                v = it.get("name") or it.get("tagName") or it.get("taxonomy1Tag") or ""
                if v:
                    out.add(str(v))
                for x in (it.get("taxonomy2Tags") or []):
                    if x:
                        out.add(str(x))
        return out

    def kol_matches_content_tags(self, kol):
        """严格过滤：检查内容标签是否包含 target_tags（详情页阶段用；空集合=不过滤）"""
        if not self.target_tags:
            return True
        tags = self._tag_values(kol.get("contentTags"))
        tags |= self._tag_values(kol.get("featureTags"))
        tags |= self._tag_values(kol.get("personalTags"))

        for tg in self.target_tags:
            if tg in tags:
                return True
        # 兼容部分标签嵌套在 taxonomy1 子串的情况
        for tg in self.target_tags:
            for t in tags:
                if tg and (t.startswith(tg) or tg.startswith(t)):
                    return True
        return False

    def kol_matches_content_tags_search(self, kol):
        """宽松预过滤（搜索列表阶段）：同时检查 contentTags/featureTags/personalTags，
        任一命中即保留；全缺失时不排除，留给详情页严格过滤。
        （v2.0.1 修复：搜索结果里"探店/氛围感"等多在 featureTags，之前只查 contentTags 会提前滤掉大量匹配博主）"""
        if not self.target_tags:
            return True
        tags = self._tag_values(kol.get("contentTags"))
        tags |= self._tag_values(kol.get("featureTags"))
        tags |= self._tag_values(kol.get("personalTags"))
        if not tags:
            return True  # 列表页没有标签数据，保留待详情页严格过滤
        for tg in self.target_tags:
            for t in tags:
                if tg and (t == tg or t.startswith(tg) or tg.startswith(t)):
                    return True
        return False

    def fan_profile_matches(self, fans_profile):
        cities = safe_get(fans_profile, "data", "cities", default=[]) or []
        top5 = [c.get("name", "") for c in cities[:5]]
        if not self.target_cities:
            return True, top5
        for c in top5:
            for tc in self.target_cities:
                if tc in c:
                    return True, top5
        return False, top5

    def is_active_recently(self, notes_rate, blogger=None, days=None):
        days = days or self.active_within_days
        notes = safe_get(notes_rate, "data", "notes", default=[]) or []
        if not notes and blogger:
            last_time = blogger.get("lastNoteTime")
            if last_time:
                dt = parse_publish_time(last_time)
                if dt:
                    return (datetime.datetime.now() - dt).days <= days
        if not notes:
            return True
        cutoff = datetime.datetime.now() - datetime.timedelta(days=days)
        for note in notes:
            dt = parse_publish_time(note.get("publishTime"))
            if dt and dt >= cutoff:
                return True
        return False

    def _coop_notes_within_months(self, all_notes):
        cutoff = datetime.datetime.now() - datetime.timedelta(days=30 * self.coop_note_months)
        coop = []
        for note in all_notes:
            if not note.get("isAdvertise"):
                continue
            dt = parse_publish_time(note.get("date") or note.get("publishTime"))
            if dt and dt >= cutoff:
                coop.append(note)
        return coop

    def get_min_imp_coop_note(self, all_notes):
        coop = self._coop_notes_within_months(all_notes)
        if not coop:
            return None
        def _imp(v):
            v = self._note_metric(v, "imp")
            return v if v is not None else float("inf")
        valid = [n for n in coop if (_imp(n) or 0) > 0]
        if valid:
            return min(valid, key=_imp)
        return None

    def get_min_like_coop_note(self, all_notes):
        coop = self._coop_notes_within_months(all_notes)
        if not coop:
            return None
        def _like(v):
            v = self._note_metric(v, "like")
            return v if v is not None else float("inf")
        return min(coop, key=_like)

    @staticmethod
    def _note_metric(note, kind):
        """从笔记对象中按多种候选字段名提取互动指标（API 优先，兼容不同命名）。
        kind: imp / read / like / collect / comment
        返回 int/float 或 None（未找到）。"""
        if not note or not isinstance(note, dict):
            return None
        cand = {
            "imp": ["impNum", "imp", "impCount", "exposure", "exposureNum", "viewCount", "view"],
            "read": ["readNum", "read", "readCount", "reads"],
            "like": ["likeNum", "like", "likeCount", "likes", "praiseNum"],
            "collect": ["collectNum", "collect", "collectCount", "favorites", "favoriteNum", "collects"],
            "comment": ["commentNum", "comment", "commentCount", "comments"],
        }.get(kind, [])
        for k in cand:
            v = note.get(k)
            if v is not None and v != "":
                try:
                    return int(v)
                except (TypeError, ValueError):
                    try:
                        return int(float(v))
                    except (TypeError, ValueError):
                        pass
        return None

    # ----- 搜索 API -----

    def fetch_search_kols(self, page):
        """分页拉取搜索列表"""
        payload = {
            "searchType": 1, "column": "comprehensiverank", "sort": "desc",
            "pageNum": 1, "pageSize": 20,
            "brandUserId": self.brand_user_id,
            "trackId": f"kolMatch_{uuid.uuid4().hex}",
            "keyword": None,
            "gender": "" if (self.gender in ("不限", "", None)) else self.gender,
            "location": self.location_cities if self.location_cities else None,
            "signed": -1, "featureTags": [], "fansAge": 0, "fansGender": 0,
            "fansLocation": self.fans_location_cities if self.fans_location_cities else None,
            "fansMaritalStatus": -1, "fansConsumptionLevel": -1,
            "fansChildAgeInfo": [], "fansDevicePrice": [], "fansDeviceBrand": [],
            "accumCommonImpMedinNum30d": [], "readMidNor30": [], "interMidNor30": [],
            "thousandLikePercent30": [], "noteType": 0,
            "notePriceLower": self.price_lower, "notePriceUpper": self.price_upper,
            "fansNumberLower": self.fans_lower, "fansNumberUpper": self.fans_upper,
            "progressOrderCnt": [], "tradeType": self.trade_type, "tradeReportBrandIdSet": [],
            "excludedTradeReportBrandId": False, "estimateCpuv30d": [], "inStar": 0,
            "firstIndustry": self.first_industry, "secondIndustry": self.second_industry,
            "newHighQuality": 0,
            "filterIntention": False,
            "flagList": [{"flagType": "HAS_BRAND_COOP_BUYER_AUTH", "flagValue": "0"},
                         {"flagType": "IS_HIGH_QUALITY", "flagValue": "0"}],
            "activityCodes": [], "excludeLowActive": False, "fansNumUp": 0,
            "excludedTradeReportBrand": False, "excludedTradeInviteReportBrand": False,
            "filterList": [], "contentSceneLabel": [],
        }

        # 关键词列表；为空时做一次无关键词搜索（仅靠类目/地域/粉丝量/报价等条件）
        search_keywords = self.keywords if self.keywords else [None]
        all_kols_dict = {}  # userId -> kol

        for keyword in search_keywords:
            if keyword is None:
                payload["keyword"] = None
            else:
                payload["keyword"] = keyword
            payload["pageNum"] = 1
            payload["trackId"] = f"kolMatch_{uuid.uuid4().hex}"

            js_code = js_fetch_json(SEARCH_API, method="POST", body=payload)
            data = page.evaluate(js_code)
            if not data:
                print(f"  [搜索] 关键词'{keyword}'无返回")
                continue

            code = data.get("code")
            if code != 0:
                print(f"  [搜索] 关键词'{keyword}'返回 code={code}")
                continue

            total = safe_get(data, "data", "total", default=0) or 0
            kols = safe_get(data, "data", "kols", default=[]) or []
            print(f"  [搜索] 关键词'{keyword}'：total={total} 首页返回={len(kols)}")
            # 预过滤：先按内容标签/报价/粉丝量过滤，减少详情页请求
            kols = [k for k in kols if self.kol_matches_content_tags_search(k)]
            print(f"  [搜索] 标签预过滤后={len(kols)}")

            for kol in kols:
                uid = kol.get("userId")
                if uid:
                    all_kols_dict[uid] = kol

            if self.max_kols > 0 and len(all_kols_dict) >= self.max_kols:
                break

            # 翻页
            page_num = 2
            while page_num <= self.max_pages and len(kols) > 0:
                payload["pageNum"] = page_num
                payload["trackId"] = f"kolMatch_{uuid.uuid4().hex}"
                js_code = js_fetch_json(SEARCH_API, method="POST", body=payload)
                data = page.evaluate(js_code)
                if not data or data.get("code") != 0:
                    break
                kols = safe_get(data, "data", "kols", default=[]) or []
                kols = [k for k in kols if self.kol_matches_content_tags_search(k)]
                for kol in kols:
                    uid = kol.get("userId")
                    if uid:
                        all_kols_dict[uid] = kol
                print(f"    [搜索] 关键词'{keyword}' 第{page_num}页 返回={len(kols)} 累计唯一={len(all_kols_dict)}")
                page_num += 1
                time.sleep(0.5)

                # 检查是否达到最大数量
                if self.max_kols > 0 and len(all_kols_dict) >= self.max_kols:
                    break

            if self.max_kols > 0 and len(all_kols_dict) >= self.max_kols:
                break

        all_kols = list(all_kols_dict.values())
        print(f"  [搜索] 共获取 {len(all_kols)} 个唯一 KOL")
        return all_kols

    # ----- 详情页采集 -----

    def fetch_kol_detail(self, context, user_id):
        """在新标签页中打开 KOL 详情页，通过 on("response") 监听捕获 API 数据"""
        captured = {"notes_detail": []}
        detail_page = context.new_page()

        def on_resp(resp):
            url = resp.url
            try:
                if resp.status != 200:
                    return
                if url.endswith(f"/api/solar/cooperator/user/blogger/{user_id}"):
                    captured["blogger"] = resp.json()
                elif f"/api/solar/kol/data/{user_id}/fans_profile" in url:
                    captured["fans_profile"] = resp.json()
                elif "/api/solar/kol/data_v3/notes_rate" in url and f"userId={user_id}" in url:
                    is_coop = "business=1" in url
                    is_organic = "advertiseSwitch=0" in url
                    key = ("notes_rate_coop_organic" if (is_coop and is_organic)
                           else "notes_rate_coop_all" if is_coop
                           else "notes_rate_daily_organic" if is_organic
                           else "notes_rate_daily_all")
                    captured[key] = resp.json()
                elif "/api/solar/kol/data_v2/notes_detail" in url and f"userId={user_id}" in url:
                    data = resp.json()
                    notes = safe_get(data, "data", "list", default=[]) or []
                    if notes:
                        captured["notes_detail"].append(data)
                elif "/api/solar/kol/data_v2/kol_content_tags" in url and f"userId={user_id}" in url:
                    captured["content_tags"] = resp.json()
                elif "/api/solar/kol/data_v2/kol_feature_tags" in url and f"userId={user_id}" in url:
                    captured["feature_tags"] = resp.json()
            except Exception:
                pass

        detail_page.on("response", on_resp)

        try:
            # 1. 导航至详情页
            detail_url = f"https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/{user_id}"
            detail_page.goto(detail_url, wait_until="domcontentloaded", timeout=30000)
            time.sleep(3)

            # 等待 blogger API
            try:
                detail_page.wait_for_response(
                    lambda r: r.url.endswith(f"/api/solar/cooperator/user/blogger/{user_id}") and r.status == 200,
                    timeout=15000
                )
            except Exception:
                pass

            # 关闭弹窗
            try:
                detail_page.evaluate(
                    "() => { const el=document.querySelector('.d-modal-close'); if(el) el.click(); }"
                )
                time.sleep(1)
            except Exception:
                pass

            # ===== 2. 数据概览 tab — 触发 notes_rate =====
            try:
                detail_page.evaluate("""() => {
                    const tabs = document.querySelectorAll('.d-tabs-header-label, [class*=tab]');
                    const t = Array.from(tabs).find(el => el.textContent.trim() === '数据概览');
                    if (t) t.click();
                }""")
                time.sleep(2)
            except Exception:
                pass

            # 滚动到数据表现区域
            try:
                detail_page.evaluate("window.scrollTo(0, 1700)")
                time.sleep(1)
            except Exception:
                pass

            # 切换流量类型到"仅自然流量"
            try:
                # 点击"全流量"下拉框
                detail_page.evaluate("""() => {
                    const spans = document.querySelectorAll('span.d-select-wrapper, .d-select, [class*=select]');
                    for (const s of spans) {
                        const txt = s.textContent.trim();
                        if (txt === '全流量') {
                            const rect = s.getBoundingClientRect();
                            if (rect.top > 1500) {
                                s.click(); return true;
                            }
                        }
                    }
                    return false;
                }""")
                time.sleep(1.5)

                # 选择"仅自然流量"
                detail_page.evaluate("""() => {
                    const items = document.querySelectorAll('.d-dropdown-item, .d-select-option, [class*=dropdown] div');
                    for (const item of items) {
                        if (item.textContent.trim() === '仅自然流量') {
                            item.click(); return true;
                        }
                    }
                    return false;
                }""")
                time.sleep(2)
            except Exception:
                pass

            # 点击数据表现区域的"日常笔记"和"合作笔记"触发 API
            for lbl in ("日常笔记", "合作笔记"):
                try:
                    detail_page.evaluate("""({l}) => {
                        const btns = Array.from(document.querySelectorAll('button'));
                        for (const b of btns) {
                            if (b.textContent.trim() === l) {
                                const rect = b.getBoundingClientRect();
                                if (rect.top > 1500) {
                                    b.click(); return true;
                                }
                            }
                        }
                        return false;
                    }""", {"l": lbl})
                    time.sleep(2)
                except Exception:
                    pass

            # ===== 3. 笔记案例 tab → 触发 notes_detail =====
            try:
                detail_page.evaluate("window.scrollTo(0, 0)")
                time.sleep(0.3)
                detail_page.evaluate("""() => {
                    const tabs = document.querySelectorAll('.d-tabs-header-label, [class*=tab]');
                    const t = Array.from(tabs).find(el => el.textContent.trim() === '笔记案例');
                    if (t) t.click();
                }""")
                time.sleep(3)
            except Exception:
                pass

            try:
                detail_page.wait_for_response(
                    lambda r: "/api/solar/kol/data_v2/notes_detail" in r.url
                              and f"userId={user_id}" in r.url and r.status == 200,
                    timeout=15000
                )
            except Exception:
                pass
            time.sleep(2)

            # ===== 4. 合作笔记 segment 筛选 =====
            # v2.0.5：点击合作笔记 segment；注意 segment 切换可能不重新请求 notes_detail API
            # （前端复用缓存），因此清空后必须主动 fetch 合作笔记 API 作为可靠数据源。
            captured["notes_detail"] = []
            try:
                detail_page.evaluate("""() => {
                    const segs = document.querySelectorAll('.d-segment-item, [class*=segment]');
                    const allCoop = Array.from(segs).filter(el => el.textContent.trim() === '合作笔记');
                    const coop = allCoop.length >= 2 ? allCoop[1] : (allCoop[0] || null);
                    if (coop) { coop.click(); return true; }
                    return false;
                }""")
                try:
                    detail_page.wait_for_response(
                        lambda r: "/api/solar/kol/data_v2/notes_detail" in r.url
                                  and f"userId={user_id}" in r.url and r.status == 200,
                        timeout=15000
                    )
                except Exception:
                    pass
                time.sleep(2)
            except Exception:
                pass

            # v2.0.5：主动 fetch 合作笔记 notes_detail（segment 可能不触发新请求，
            # 必须确保抽屉提取有可靠的 API 顺序数据）
            try:
                url = (f"https://pgy.xiaohongshu.com/api/solar/kol/data_v2/notes_detail"
                       f"?userId={user_id}&pageNum=1&pageSize=20")
                js = js_fetch_json(url)
                data = detail_page.evaluate(js)
                if data and data.get("code") == 0:
                    notes = safe_get(data, "data", "list", default=[]) or []
                    if notes:
                        captured["notes_detail"] = [data]
                        print(f"      [主动fetch] 合作笔记 notes_detail 获取 {len(notes)} 条")
            except Exception as e:
                print(f"      [主动fetch] 失败: {e}")

            # ===== 5. 翻页 + 抽屉曝光提取 =====
            pull_cutoff = datetime.datetime.now() - datetime.timedelta(days=30 * self.coop_note_months)
            seen_ids = set()
            note_exposure = captured.setdefault("note_exposure", {})

            for pg in range(1, self.coop_note_pages_max + 1):
                all_detail_notes = []
                for item in captured.get("notes_detail") or []:
                    all_detail_notes.extend(safe_get(item, "data", "list", default=[]) or [])

                new_notes = [n for n in all_detail_notes if n.get("noteId") and n["noteId"] not in seen_ids]
                if new_notes:
                    seen_ids.update(n.get("noteId") for n in new_notes)

                if pg > 1:
                    clicked = detail_page.evaluate(
                        """({pnum}) => {
                            const pages = document.querySelectorAll('.d-pagination-page, [class*=pagination]');
                            const found = Array.from(pages).find(el => {
                                const span = el.querySelector('.d-text, span');
                                return (span ? span.textContent.trim() : el.textContent.trim()) === String(pnum);
                            });
                            if (found) { found.scrollIntoView({block: 'center'}); found.click(); return true; }
                            return false;
                        }""",
                        {"pnum": pg},
                    )
                    if not clicked:
                        break
                    time.sleep(3)
                    try:
                        detail_page.wait_for_response(
                            lambda r: "/api/solar/kol/data_v2/notes_detail" in r.url
                                      and f"userId={user_id}" in r.url and r.status == 200,
                            timeout=10000
                        )
                    except Exception:
                        pass
                    time.sleep(2)

                if not new_notes:
                    continue

                # v2.0.5 修正：合作笔记 segment 点击后 DOM 显示的就是合作笔记卡片（.note-card-wrapper），
                # API 的 isAdvertise 标记并不可靠（部分达人 segment 返回仍是日常笔记），
                # 因此直接遍历 DOM 全部合作笔记卡片逐个提取抽屉（每张卡片抽屉都有「本篇笔记数据」曝光面板）。
                # 注意：不再按 API isAdvertise 做时间范围 break（合作笔记 segment 的 API 标记可能全为 False，
                #       若用 old 判断会提前 break，导致抽屉曝光完全没提取）。
                dom_count = detail_page.evaluate("() => document.querySelectorAll('.note-card-wrapper').length")
                if dom_count <= 0:
                    continue
                # 建立 noteId -> API 笔记 映射（补充 readNum/likeNum 等 API 字段）
                api_by_id = {n.get("noteId"): n for n in all_detail_notes if n.get("noteId")}

                for ci in range(dom_count):
                    note = api_by_id.get("") or {}
                    # 抽屉提取后通过抽屉标题/图片近似关联，若无法关联则先按卡片索引保存占位，
                    # 抽屉内的曝光/阅读/点赞通过 note_exposure 的 key 注入到 build_row（见 note_field 的 _note_metric fallback）。
                    nid = None  # 抽屉提取后会从 DOM 反查 noteId（见下方 drawer_nid）

                    if ci > 0:
                        # 关闭上一个抽屉
                        try:
                            detail_page.keyboard.press("Escape")
                            time.sleep(0.6)
                        except Exception:
                            pass

                    clicked = detail_page.evaluate(
                        """({idx}) => {
                            const cards = document.querySelectorAll('.note-card-wrapper');
                            if (idx >= cards.length) return false;
                            const card = cards[idx];
                            const mask = card.querySelector('.note-card__mask, [class*=mask]');
                            if (mask) { mask.scrollIntoView({block: 'center'}); mask.click(); return true; }
                            card.scrollIntoView({block: 'center'});
                            card.click();
                            return true;
                        }""",
                        {"idx": ci},
                    )
                    if not clicked:
                        continue
                    time.sleep(2.5)

                    drawer_data = detail_page.evaluate("""() => {
                        let c = document.querySelector('.d-drawer-content, [class*=drawer-content], [class*=drawerContent]');
                        if (!c) {
                            const allDivs = document.querySelectorAll('div[class*=overlay], div[class*=modal], div[class*=drawer]');
                            for (const d of allDivs) {
                                if (d.textContent.includes('曝光量') && d.offsetHeight > 100) {
                                    c = d; break;
                                }
                            }
                        }
                        if (!c) return null;
                        const lines = c.innerText.split('\\n').map(l=>l.trim()).filter(l=>l);
                        const parseNum = (s, unit) => {
                            const raw = parseFloat((s||'').replace(/,/g,''));
                            if (isNaN(raw)) return null;
                            if (unit === '万' || unit === 'w') return Math.round(raw * 10000);
                            if (unit === '千' || unit === 'k') return Math.round(raw * 1000);
                            return Math.round(raw);
                        };
                        const ex = (label) => {
                            for(let i=0;i<lines.length;i++){
                                if(lines[i]===label || lines[i].startsWith(label)){
                                    // 布局 A：同行式「曝光量 1,475」/「曝光量：1,475」——直接从当前行提取数字
                                    const same = lines[i].match(/([\d,.]+)\s*(万|千|w|k)?\s*$/);
                                    if (same) {
                                        const n = parseNum(same[1], same[2]);
                                        if (n !== null) return n;
                                    }
                                    // 布局 B：换行式「曝光量\\n1,475」/「曝光量\\n1.5万」——取下一行数字
                                    const next = lines[i+1];
                                    if (next) {
                                        const m = next.match(/([\d,.]+)\s*(万|千|w|k)?/);
                                        const n = m ? parseNum(m[1], m[2]) : null;
                                        if (n !== null) return n;
                                    }
                                }
                            }
                            return null;
                        };
                        return {
                            title: lines[0]||'',
                            text: lines.slice(0, 40).join(' | ').slice(0, 2000),
                            exposure: ex('曝光量') || ex('曝光'),
                            reads: ex('阅读量') || ex('阅读'),
                            likes: ex('点赞量') || ex('点赞'),
                            favorites: ex('收藏量') || ex('收藏'),
                            comments: ex('评论量') || ex('评论'),
                        };
                    }""")

                    # v2.0.5：抽屉数据提取 + 关联
                    #  用抽屉标题与 API 笔记标题做前缀匹配，反查 noteId；匹配失败时用 card_{ci} 占位，
                    #  build_row 的 _note_metric 会按 note_exposure key 读取（详见 note_field 的 fallback）。
                    #  物理校验仅拦截严重异常（阅读 > 10x 曝光 或 点赞 > 阅读）。
                    exp = None
                    drawer_ok = False
                    if drawer_data:
                        exp = drawer_data.get("exposure")
                        reads = drawer_data.get("reads")
                        likes = drawer_data.get("likes")
                        phys_ok = True
                        if exp:
                            if reads and reads > exp * 10:
                                phys_ok = False
                            if likes and reads and likes > reads:
                                phys_ok = False
                        if exp and phys_ok:
                            drawer_ok = True

                    # 反查 noteId：抽屉标题 vs API 笔记标题（前缀匹配）
                    nid = None
                    if drawer_ok:
                        drawer_title = (drawer_data.get("title") or "").strip()
                        best = None
                        for cand_id, cand in api_by_id.items():
                            cand_title = (cand.get("title") or "").strip()
                            if drawer_title and cand_title:
                                if (drawer_title[:10] in cand_title) or (cand_title[:10] in drawer_title):
                                    best = cand_id
                                    break
                        if best is None and drawer_title:
                            for cand_id, cand in api_by_id.items():
                                cand_title = (cand.get("title") or "").strip()
                                if cand_title and drawer_title[:5] in cand_title:
                                    best = cand_id
                                    break
                        nid = best or f"card_{ci}"

                    if drawer_ok and nid:
                        note_exposure[nid] = drawer_data["exposure"]
                        for k2, kk in (("reads", "readNum"), ("likes", "likeNum"),
                                       ("favorites", "collectNum"), ("comments", "commentNum")):
                            if drawer_data.get(k2):
                                note_exposure[f"{nid}_{kk}"] = drawer_data[k2]
                    else:
                        print(f"      [SKIP] 抽屉无有效曝光 card={ci} exp={exp}")

                    # v2.1：保存抽屉内文本信号（标题+正文片段+可能的POI/团购/人均信息）
                    if drawer_data and nid:
                        captured.setdefault("note_texts", {})[nid] = {
                            "title": drawer_data.get("title") or "",
                            "text": drawer_data.get("text") or "",
                        }

                    # v2.2：抓取评论明细（grab_comments=true 时）——抽屉内评论区 DOM + 评论者昵称
                    if self.grab_comments and nid:
                        try:
                            time.sleep(1.2)
                            cmts = detail_page.evaluate("""() => {
                                const pick = (el) => {
                                    if (!el) return null;
                                    const t = el.textContent.trim();
                                    return t ? t.slice(0, 300) : null;
                                };
                                // 抽屉内寻找评论列表容器（评论 item 通常含头像+昵称+文本）
                                let c = document.querySelector('.d-drawer-content, [class*=drawer-content], [class*=drawerContent]');
                                if (!c) return [];
                                const blocks = c.querySelectorAll('[class*=comment-item], [class*=commentItem], [class*=comment__item]');
                                const out = [];
                                if (blocks.length) {
                                    blocks.forEach(b => {
                                        const nick = pick(b.querySelector('[class*=comment-item__name], [class*=commentItem__name], [class*=comment-name], [class*=commentName]'));
                                        const txt = pick(b.querySelector('[class*=comment-item__content], [class*=commentItem__content], [class*=comment-content], [class*=commentContent]'));
                                        if (txt || nick) out.push({user: nick || '', text: txt || ''});
                                    });
                                } else {
                                    // 兜底：按行解析“昵称 文本”模式（页面结构不稳时尽量抓）
                                    const lines = (c.innerText || '').split('\\n').map(l=>l.trim()).filter(l=>l);
                                    for (let i = 0; i < lines.length && out.length < 20; i++) {
                                        if (lines[i] && lines[i].length > 2 && !['曝光量','阅读量','点赞量','收藏量','评论量','全部评论','评论'].includes(lines[i])) {
                                            out.push({user: lines[i], text: lines[i+1] || ''});
                                            i++;
                                        }
                                    }
                                }
                                return out.slice(0, 20);
                            }""")
                            if cmts:
                                captured.setdefault("comment_samples", {})[nid] = cmts
                        except Exception:
                            pass

                    # 关闭抽屉
                    try:
                        detail_page.keyboard.press("Escape")
                        time.sleep(0.8)
                    except Exception:
                        pass
                    still_open = detail_page.evaluate("""() => {
                        const d = document.querySelector('.d-drawer-guard');
                        return d && d.offsetParent != null;
                    }""")
                    if still_open:
                        detail_page.evaluate("""() => {
                            const d = document.querySelector('.d-drawer-guard');
                            if (d) d.click();
                        }""")
                        time.sleep(0.5)

            # ---- 主动 API 兜底 ----
            if not any(k.startswith("notes_rate_") for k in captured):
                print(f"      [兜底] notes_rate 未捕获，主动 fetch API...")
                for business, label in ((0, "daily"), (1, "coop")):
                    for adv_sw, suffix in ((0, "organic"), (1, "all")):
                        key = f"notes_rate_{label}_{suffix}"
                        if key not in captured:
                            try:
                                url = (f"https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate"
                                       f"?userId={user_id}&business={business}&advertiseSwitch={adv_sw}&pageSize=20&pageNum=1")
                                js = js_fetch_json(url)
                                data = detail_page.evaluate(js)
                                if data and data.get("code") == 0:
                                    captured[key] = data
                            except Exception:
                                pass

            if not captured.get("notes_detail"):
                print(f"      [兜底] notes_detail 未捕获，主动 fetch API...")
                for pn in (1, 2):
                    try:
                        url = (f"https://pgy.xiaohongshu.com/api/solar/kol/data_v2/notes_detail"
                               f"?userId={user_id}&pageNum={pn}&pageSize=20")
                        js = js_fetch_json(url)
                        data = detail_page.evaluate(js)
                        if data and data.get("code") == 0:
                            notes = safe_get(data, "data", "list", default=[]) or []
                            if notes:
                                captured.setdefault("notes_detail", []).append(data)
                    except Exception:
                        pass

        except Exception as e:
            print(f"      [ERROR] 详情页处理异常: {e}")
            import traceback; traceback.print_exc()

        finally:
            detail_page.remove_listener("response", on_resp)
            detail_page.close()

        return captured

    # ----- 构建 CSV 行 -----

    def extract_relevance_samples(self, captured):
        """v2.1：从详情页数据中抽取与 target_tags/relevance_keywords 相关的帖子样本。
        返回 list[dict]：{noteId, title, text, impNum, readNum, likeNum, commentNum, isAdvertise, date}
        优先按相关性关键词过滤；无关键词时退回取合作笔记样本。"""
        all_notes = []
        for item in captured.get("notes_detail") or []:
            all_notes.extend(safe_get(item, "data", "list", default=[]) or [])

        note_exposure = captured.get("note_exposure") or {}
        note_texts = captured.get("note_texts") or {}
        comment_samples = captured.get("comment_samples") or {}  # v2.2
        for note in all_notes:
            nid = note.get("noteId")
            if nid and nid in note_exposure:
                # API 字段优先，抽屉仅补充缺失（避免错位污染）
                api_has = {k: self._note_metric(note, k) for k in ("imp", "read", "like", "collect", "comment")}
                if api_has["imp"] is None:
                    note["impNum"] = note_exposure[nid]
                if api_has["read"] is None:
                    note["readNum"] = note_exposure.get(f"{nid}_readNum")
                if api_has["like"] is None:
                    note["likeNum"] = note_exposure.get(f"{nid}_likeNum")
                if api_has["collect"] is None:
                    note["collectNum"] = note_exposure.get(f"{nid}_collectNum")
                if api_has["comment"] is None:
                    note["commentNum"] = note_exposure.get(f"{nid}_commentNum")
            if nid and nid in note_texts:
                note["_title"] = note_texts[nid].get("title", "")
                note["_text"] = note_texts[nid].get("text", "")
            if nid and nid in comment_samples:
                note["_comments"] = comment_samples[nid]

        # 过滤出与合作相关帖子（优先 isAdvertise，含 _text/_title 的样本）
        candidates = [n for n in all_notes if n.get("isAdvertise")]
        if not candidates:
            candidates = [n for n in all_notes if n.get("_text") or n.get("_title")]
        if not candidates:
            return []

        # 按相关性关键词过滤（如水果 → 食品/饮料相关）
        keywords = list(self.target_tags) + [k for k in self.relevance_keywords if k]
        scored = []
        for n in candidates:
            hay = " ".join(str(n.get(k, "")) for k in ("_title", "_text", "title", "tags", "contentTags") if n.get(k))
            score = 0
            for kw in keywords:
                if kw and kw in hay:
                    score += 1
            scored.append((score, n))
        # 关键词命中优先，其次保留原顺序（有正文样本优先）
        scored.sort(key=lambda x: (-x[0], 0 if (x[1].get("_text") or x[1].get("_title")) else 1))
        out = []
        for score, n in scored[: self.sample_note_count]:
            out.append({
                "noteId": n.get("noteId"),
                "title": n.get("_title") or n.get("title") or "",
                "text": (n.get("_text") or "")[:1500],
                "impNum": self._note_metric(n, "imp") or 0,
                "readNum": self._note_metric(n, "read") or 0,
                "likeNum": self._note_metric(n, "like") or 0,
                "commentNum": self._note_metric(n, "comment") or 0,
                "isAdvertise": bool(n.get("isAdvertise")),
                "date": n.get("date") or n.get("publishTime") or "",
                "comments": n.get("_comments") or [],  # v2.2：评论明细（grab_comments=true 时）
                "matched_keywords": [kw for kw in keywords if kw and kw in (
                    " ".join(str(n.get(k, "")) for k in ("_title", "_text", "title", "tags", "contentTags") if n.get(k))
                )],
            })
        return out

    def build_row(self, kol, blogger, captured, top5_cities, fans_profile):
        notes_rate_daily = captured.get("notes_rate_daily_organic") or captured.get("notes_rate_daily_all") or {}
        notes_rate_coop = captured.get("notes_rate_coop_organic") or captured.get("notes_rate_coop_all") or {}

        all_detail_notes = []
        for item in captured.get("notes_detail") or []:
            all_detail_notes.extend(safe_get(item, "data", "list", default=[]) or [])

        female_ratio = safe_get(fans_profile, "data", "gender", "female", default=None)
        female_pct = round(female_ratio, 2) if female_ratio is not None else None

        pic_price = blogger.get("picturePrice")
        vid_price = blogger.get("videoPrice")
        pic_price_wan = pic_price / 10000 if pic_price is not None else None
        vid_price_wan = vid_price / 10000 if vid_price is not None else None

        # 有效报价用于 CPM/CPE 计算
        effective_price = None
        if pic_price is not None and self.price_lower <= pic_price <= self.price_upper:
            effective_price = pic_price
        if vid_price is not None and self.price_lower <= vid_price <= self.price_upper:
            if effective_price is None or vid_price < effective_price:
                effective_price = vid_price
        if effective_price is None:
            effective_price = pic_price or vid_price

        # 注入互动数据：优先 API 自带字段，抽屉数据仅补充缺失项
        # （API 返回的 notes_detail 通常自带曝光/阅读/点赞；抽屉 DOM 提取容易因布局变化错位，
        #   只有 API 缺失时才用抽屉值兜底，避免「阅读 > 曝光」这类字段错位污染最低曝光/最低点赞）
        note_exposure = captured.get("note_exposure") or {}
        for note in all_detail_notes:
            nid = note.get("noteId")
            if not nid or nid not in note_exposure:
                continue
            api_has = {k: self._note_metric(note, k) for k in ("imp", "read", "like", "collect", "comment")}
            if api_has["imp"] is None:
                note["impNum"] = note_exposure[nid]
            if api_has["read"] is None:
                note["readNum"] = note_exposure.get(f"{nid}_readNum")
            if api_has["like"] is None:
                note["likeNum"] = note_exposure.get(f"{nid}_likeNum")
            if api_has["collect"] is None:
                note["collectNum"] = note_exposure.get(f"{nid}_collectNum")
            if api_has["comment"] is None:
                note["commentNum"] = note_exposure.get(f"{nid}_commentNum")

        # v2.0.5：抽屉占位笔记（card_* 或未匹配 API 的抽屉数据）并入 min 候选，
        # 避免「API 无 isAdvertise 标记/无对应笔记」时最低曝光/最低点赞丢失
        drawer_candidates = []
        for dkey in note_exposure:
            # 只处理「主曝光 key」（noteId 或 card_xxx），跳过 {key}_readNum 等后缀辅助 key
            if not isinstance(dkey, str):
                continue
            if dkey.endswith(("_readNum", "_likeNum", "_collectNum", "_commentNum")):
                continue
            imp = note_exposure[dkey]
            if imp:
                # 占位笔记补 date=今天（DOM 合作笔记卡片均在近 3 个月内，避免被时间过滤丢弃）
                drawer_candidates.append({
                    "noteId": dkey,
                    "isAdvertise": True,
                    "impNum": imp,
                    "readNum": note_exposure.get(f"{dkey}_readNum"),
                    "likeNum": note_exposure.get(f"{dkey}_likeNum"),
                    "collectNum": note_exposure.get(f"{dkey}_collectNum"),
                    "commentNum": note_exposure.get(f"{dkey}_commentNum"),
                    "date": datetime.datetime.now().strftime("%Y-%m-%d"),
                })
        # 合并：API 笔记 + 抽屉候选（按 noteId 去重，抽屉候选优先）
        merged_notes = {n.get("noteId"): n for n in all_detail_notes if n.get("noteId")}
        for dc in drawer_candidates:
            merged_notes[dc["noteId"]] = dc
        merged_list = list(merged_notes.values())
        # 保留原始 all_detail_notes 顺序（isAdvertise 筛选用），追加抽屉候选
        min_imp_note = self.get_min_imp_coop_note(merged_list)
        min_like_note = self.get_min_like_coop_note(merged_list)

        # 计算 CPM / CPE（优先用合作笔记最低曝光/最低点赞笔记的真实值；缺失时回退中位数）
        cpm = None
        cpe = None
        if effective_price:
            if min_imp_note:
                imp = self._note_metric(min_imp_note, "imp") or 0
                if imp > 0:
                    cpm = effective_price / imp * 1000
            if cpm is None:
                coop_imp_median = safe_get(notes_rate_coop, "data", "impMedian", default=None)
                if coop_imp_median and coop_imp_median > 0:
                    cpm = effective_price / coop_imp_median * 1000
            if min_like_note:
                like = self._note_metric(min_like_note, "like")
                if like is not None and like > 0:
                    cpe = effective_price / like

        def nr_median(nr, key):
            return safe_get(nr, "data", key, default=None)

        def note_field(note, kind, fallback_keys=None):
            if not note:
                return None
            v = self._note_metric(note, kind)
            if v is not None:
                return v
            for k in (fallback_keys or []):
                if k in note and note[k] is not None:
                    return note[k]
            return None

        # 获取内容标签和擅长标签
        content_tags = captured.get("content_tags")
        feature_tags = captured.get("feature_tags")
        content_tag_str = format_content_tags(
            safe_get(content_tags, "data", default=[])
        ) if content_tags else format_content_tags(blogger.get("contentTags") or kol.get("contentTags"))

        feature_tag_list = safe_get(feature_tags, "data", default=[]) if feature_tags else (blogger.get("featureTags") or kol.get("featureTags") or [])
        if isinstance(feature_tag_list, list):
            parts = []
            for ft in feature_tag_list:
                if isinstance(ft, str):
                    parts.append(ft)
                elif isinstance(ft, dict):
                    v = ft.get("name") or ft.get("tagName") or ""
                    if v:
                        parts.append(str(v))
            feature_tag_str = ";".join(parts)
        else:
            feature_tag_str = str(feature_tag_list) if feature_tag_list else ""

        # ---- v2.1：相关帖子抽样（供风格/价格带/评论画像/CPM·CPE 校验使用） ----
        samples = self.extract_relevance_samples(captured)
        sample_titles = " | ".join(s["title"] for s in samples if s.get("title"))[:800]
        sample_text = " || ".join(s["text"] for s in samples if s.get("text"))[:3000]
        # POI/团购/人均 信号识别（文本关键词，供价格带校验粗筛）
        poi_signals = []
        for s in samples:
            for kw in ("人均", "客单", "元/", "价格", "团购", "套餐", "地址", "门店", "¥", "￥"):
                if s.get("text") and kw in s["text"]:
                    poi_signals.append(kw)
                    break
        # v2.2：评论明细聚合信号（grab_comments=true 时才有）
        all_comments = [c for s in samples for c in (s.get("comments") or [])]
        comment_users = " | ".join(dict.fromkeys(c.get("user", "") for c in all_comments if c.get("user")))[:600]
        comment_texts = " || ".join(c.get("text", "") for c in all_comments if c.get("text"))[:2000]
        sample_imp = sum(int(s.get("impNum") or 0) for s in samples)
        sample_read = sum(int(s.get("readNum") or 0) for s in samples)
        sample_like = sum(int(s.get("likeNum") or 0) for s in samples)
        sample_comment = sum(int(s.get("commentNum") or 0) for s in samples)

        return {
            "达人名称": blogger.get("name") or kol.get("name") or "",
            "小红书号": blogger.get("xiaohongshuId") or kol.get("xiaohongshuId") or kol.get("userId") or "",
            "userId": blogger.get("userId") or kol.get("userId") or "",
            "内容类目": content_tag_str,
            "地域": (blogger.get("location") or kol.get("location") or "").strip(),
            "粉丝量": blogger.get("fansCount") or kol.get("fansCount") or kol.get("fansNum") or 0,
            "粉丝所在区域（前五城市）": ";".join(top5_cities),
            "获赞与收藏": blogger.get("likeCollectCountInfo") or 0,
            "图文报价（万）": pic_price_wan,
            "视频报价（万）": vid_price_wan,
            "女性粉丝占比": female_pct,
            "日常笔记发布篇数": nr_median(notes_rate_daily, "noteNumber"),
            "日常笔记曝光中位数": nr_median(notes_rate_daily, "impMedian"),
            "日常笔记阅读中位数": nr_median(notes_rate_daily, "readMedian"),
            "日常笔记点赞中位数": nr_median(notes_rate_daily, "likeMedian"),
            "合作笔记发布篇数": nr_median(notes_rate_coop, "noteNumber"),
            "合作笔记曝光中位数": nr_median(notes_rate_coop, "impMedian"),
            "合作笔记阅读中位数": nr_median(notes_rate_coop, "readMedian"),
            "合作笔记点赞中位数": nr_median(notes_rate_coop, "likeMedian"),
            "合作笔记最低曝光": note_field(min_imp_note, "imp"),
            "合作笔记最低曝光阅读": note_field(min_imp_note, "read"),
            "合作笔记最低曝光点赞": note_field(min_imp_note, "like"),
            "合作笔记最低曝光收藏": note_field(min_imp_note, "collect"),
            "合作笔记最低曝光评论": note_field(min_imp_note, "comment"),
            "合作笔记最低曝光时间": min_imp_note.get("date") if min_imp_note else None,
            "合作笔记最低点赞": note_field(min_like_note, "like"),
            "合作笔记最低点赞阅读": note_field(min_like_note, "read"),
            "合作笔记最低点赞收藏": note_field(min_like_note, "collect"),
            "合作笔记最低点赞评论": note_field(min_like_note, "comment"),
            "合作笔记最低点赞时间": min_like_note.get("date") if min_like_note else None,
            "内容标签": content_tag_str,
            "擅长标签": feature_tag_str,
            "预估CPM": round(cpm, 2) if cpm is not None else None,
            "预估CPE": round(cpe, 2) if cpe is not None else None,
            # ---- v2.1 新增列 ----
            "相关帖子抽样数": len(samples),
            "相关帖子标题": sample_titles,
            "相关帖子正文片段": sample_text,
            "相关帖子POI/团购信号": ";".join(sorted(set(poi_signals))) if poi_signals else "",
            "相关帖子评论数": sample_comment,
            "相关帖子曝光合计": sample_imp,
            "相关帖子阅读合计": sample_read,
            "相关帖子点赞合计": sample_like,
            "相关帖子评论合计": sample_comment,
            "评论样本用户": comment_users,
            "评论样本文本": comment_texts,
            "数据来源": "蒲公英",
        }

    # ----- 主流程 -----

    def _init_browser(self, p, cdp_url, output_file):
        """连接 CDP、初始化主页面并检查登录态；失败抛异常由调用方处理。
        （v2.0.1 新增：供 run() 初始化与中断自动重连复用）"""
        print(f"正在连接 Chrome CDP: {cdp_url}")
        try:
            browser = p.chromium.connect_over_cdp(cdp_url)
        except Exception as e:
            raise RuntimeError(f"无法连接 Chrome CDP: {e}")
        context = browser.contexts[0]

        main_page = None
        for pg in context.pages:
            url = pg.url
            if "/solar/pre-trade" in url and "blogger-detail" not in url:
                main_page = pg
                print(f"找到蒲公英页面: {url}")
                break
        if not main_page:
            for pg in context.pages:
                url = pg.url
                if not url.startswith("chrome://") and not url.startswith("chrome-extension://"):
                    main_page = pg
                    print(f"使用标签页: {url}")
                    break
        if not main_page:
            main_page = context.new_page()
            print("新建标签页")

        if "/solar/pre-trade/note/kol" not in main_page.url:
            print("导航至蒲公英笔记博主广场...")
            main_page.goto(
                "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
                wait_until="domcontentloaded", timeout=60000
            )
            time.sleep(3)

        try:
            body_text = main_page.inner_text("body")
            if "账号登录" in body_text or "立即登录" in body_text:
                raise RuntimeError("未检测到蒲公英登录态")
        except RuntimeError:
            raise
        except Exception:
            print("检查登录态时异常，继续...")
        print("登录态正常")
        return browser, context, main_page

    @staticmethod
    def _is_conn_lost(e):
        """判断异常是否属于浏览器/连接/网络中断（可自动重连恢复；v2.0.2 补入 net:: 网络错误）"""
        msg = str(e)
        closed_markers = ("has been closed", "Target closed", "Connection closed",
                          "browser has been closed", "context has been closed",
                          "Target page, context or browser has been closed",
                          "net::ERR_INTERNET_DISCONNECTED", "net::ERR_NETWORK_CHANGED",
                          "net::ERR_CONNECTION", "net::ERR_NAME_NOT_RESOLVED",
                          "net::ERR_ADDRESS_UNREACHABLE", "net::ERR_TIMED_OUT",
                          "ERR_INTERNET_DISCONNECTED", "ERR_NETWORK_CHANGED")
        return any(m in msg for m in closed_markers)

    @staticmethod
    def _load_done_user_ids(output_file):
        """读取已产出 CSV 的 userId 列（v2.0.2：独立 userId 列 + csv 模块解析；
        旧 CSV 无 userId 列时回退读「小红书号」列，当前数据该列即 userId 格式）"""
        done = set()
        if not output_file or not os.path.exists(output_file):
            return done
        try:
            with open(output_file, "r", encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    uid = (row.get("userId") or row.get("小红书号") or "").strip()
                    if uid:
                        done.add(uid)
        except Exception:
            pass
        return done

    @staticmethod
    def _load_existing_rows(output_file):
        """读取已有 CSV 的所有数据行（v2.0.2 新增：末尾合并写入用，防止断点重跑整表覆写丢数据）"""
        rows = []
        if not output_file or not os.path.exists(output_file):
            return rows
        try:
            with open(output_file, "r", encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    if row and any(v not in (None, "") for v in row.values()):
                        rows.append(row)
        except Exception:
            pass
        return rows

    def run(self, output_file, debug_file=None):
        results = []
        debug = {"errors": [], "filtered_in": [], "filtered_out": []}
        notes_samples = {"kols": []}  # v2.1：相关帖子抽样笔记（供校验引擎使用）

        cdp_url = f"http://127.0.0.1:{self.cdp_port}"

        with playwright.sync_api.sync_playwright() as p:
            print("请确保：")
            print("  1. Chrome 已打开远程调试端口（--remote-debugging-port=9222）")
            print("  2. 已登录小红书蒲公英（pgy.xiaohongshu.com）")
            print()
            try:
                browser, context, main_page = self._init_browser(p, cdp_url, output_file)
            except Exception as e:
                print(f"\n[FAIL] 浏览器初始化失败: {e}")
                print("请先启动带远程调试端口的 Chrome：")
                print("  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\")
                print("    --remote-debugging-port=9222 --user-data-dir=/tmp/chrome_pgy_debug")
                print("再运行 --check 验证后重试。")
                return results

            # ========== 1. 搜索列表 ==========
            print("\n" + "=" * 60)
            print("Step 1: 搜索 KOL")
            print(f"筛选条件：地域{list(self.target_cities)} / 粉丝{self.fans_lower}-{self.fans_upper} / 报价{self.price_lower}-{self.price_upper}")
            print(f"关键词：{self.keywords}  内容标签：{list(self.target_tags)}  类目：{self.first_industry}/{self.second_industry}")
            print("=" * 60)

            all_kols = self.fetch_search_kols(main_page)
            print(f"\n搜索共返回 {len(all_kols)} 个 KOL")

            # ========== 2. 预过滤 + 逐个采集详情 ==========
            print("\n" + "=" * 60)
            print("Step 2: 逐个评估 KOL")
            print("=" * 60)

            # 先基于列表页数据做预过滤
            candidates = []
            for kol in all_kols:
                name = kol.get("name") or ""
                user_id = kol.get("userId")

                if not self.kol_matches_location(kol):
                    debug["filtered_out"].append({"name": name, "reason": "location", "location": kol.get("location")})
                    continue
                if not self.kol_matches_price(kol):
                    debug["filtered_out"].append({"name": name, "reason": "price"})
                    continue
                if not self.kol_matches_fans(kol):
                    debug["filtered_out"].append({"name": name, "reason": "fans"})
                    continue

                candidates.append(kol)

            print(f"预过滤后剩余 {len(candidates)} 个 KOL 进入详情采集")

            # 断点续采：已出现在输出 CSV 中的 userId 直接跳过（v2.0.1 新增）
            done_ids = self._load_done_user_ids(output_file)
            if done_ids:
                print(f"  检测到已有产出 {len(done_ids)} 条，跳过这些 userId（断点续采）")
            if self.force_redownload_ids:
                # v2.0.3：强制重采的 userId 不受断点去重影响
                # 1) 保留命中强制列表的搜索候选；2) 其余普通候选按断点去重
                forced_hit = [k for k in candidates if k.get("userId") in self.force_redownload_ids]
                normal = [k for k in candidates if k.get("userId") not in self.force_redownload_ids and k.get("userId") not in done_ids]
                # 3) 搜索未命中的强制 userId：从已有 CSV 行构造最小对象（fetch_kol_detail 只依赖 userId）
                missing_forced = self.force_redownload_ids - {k.get("userId") for k in forced_hit}
                if missing_forced:
                    existing = self._load_existing_rows(output_file)
                    uid_to_name = { (r.get("userId") or r.get("小红书号") or ""): (r.get("达人名称") or "") for r in existing }
                    for uid in missing_forced:
                        forced_hit.append({"userId": uid, "name": uid_to_name.get(uid, uid)})
                    print(f"  强制重采中有 {len(missing_forced)} 个未在本次搜索命中，已从已有 CSV 补齐")
                candidates = forced_hit + normal
                print(f"  强制重采 {len(forced_hit)} 个（{', '.join(str(k.get('userId')) for k in forced_hit[:8])}{'...' if len(forced_hit)>8 else ''}）")
            else:
                candidates = [k for k in candidates if k.get("userId") not in done_ids]
            print(f"断点去重后待采集 {len(candidates)} 个")

            for idx, kol in enumerate(candidates, start=1):
                user_id = kol.get("userId")
                name = kol.get("name") or ""
                print(f"\n[{idx}/{len(candidates)}] {name} (userId={user_id})")

                # 打开详情页采集（连接中断时自动重连并重试一次）
                try:
                    captured = self.fetch_kol_detail(context, user_id)
                except Exception as e:
                    if self._is_conn_lost(e):
                        print(f"  [WARN] 浏览器连接中断: {str(e)[:120]}")
                        print("  -> 尝试自动重连 Chrome CDP ...")
                        try:
                            browser, context, main_page = self._init_browser(p, cdp_url, output_file)
                            print("  -> 重连成功，重试当前 KOL")
                            captured = self.fetch_kol_detail(context, user_id)
                        except Exception as e2:
                            print(f"  [FAIL] 重连失败: {e2}")
                            print("  -> 请检查 Chrome 是否被关闭 / CDP 端口是否仍开启；后续 KOL 停止采集")
                            debug["errors"].append({"name": name, "error": f"conn_lost_reconnect_failed: {e2}"})
                            break
                    else:
                        print(f"  [ERROR] 详情页采集异常: {e}")
                        traceback.print_exc()
                        debug["errors"].append({"name": name, "error": str(e)[:200]})
                        continue

                blogger = safe_get(captured, "blogger", "data", default={}) or {}
                if not blogger:
                    print(f"  [WARN] 博主详情为空，跳过")
                    debug["errors"].append({"name": name, "stage": "blogger_empty"})
                    continue

                # 二次过滤（基于详情页更精确的数据）
                if not self.kol_matches_location(blogger):
                    print(f"  -> 过滤: 地域不符")
                    debug["filtered_out"].append({"name": name, "reason": "detail_location"})
                    continue
                if not self.kol_matches_price(blogger):
                    print(f"  -> 过滤: 报价不符")
                    debug["filtered_out"].append({"name": name, "reason": "detail_price"})
                    continue
                if not self.kol_matches_fans(blogger):
                    print(f"  -> 过滤: 粉丝量不符")
                    debug["filtered_out"].append({"name": name, "reason": "detail_fans"})
                    continue
                if not self.kol_matches_content_tags(blogger):
                    print(f"  -> 过滤: 内容标签不含 {list(self.target_tags)}")
                    debug["filtered_out"].append({"name": name, "reason": "detail_tags"})
                    continue

                # 活跃度检查
                notes_rate_check = captured.get("notes_rate_daily_organic") or captured.get("notes_rate_daily_all") or {}
                if not self.is_active_recently(notes_rate_check, blogger):
                    print(f"  -> 过滤: 近期未更新")
                    debug["filtered_out"].append({"name": name, "reason": "inactive"})
                    continue

                # 粉丝地域检查
                fans_profile = captured.get("fans_profile") or {}
                ok_city, top5_cities = self.fan_profile_matches(fans_profile)
                if not ok_city:
                    print(f"  -> 过滤: 粉丝地域不含 {list(self.target_cities)} (top5={top5_cities})")
                    debug["filtered_out"].append({"name": name, "reason": "fan_city"})
                    continue

                # 构建数据行（单条失败不中断整体采集）
                try:
                    row = self.build_row(kol, blogger, captured, top5_cities, fans_profile)
                except Exception as e:
                    print(f"  [ERROR] 构建数据行失败: {e}")
                    debug["errors"].append({"name": name, "error": f"build_row: {e}"})
                    continue
                results.append(row)
                debug["filtered_in"].append({"name": row["达人名称"], "userId": user_id})
                print(f"  -> MATCH: {row['达人名称']} (累计 {len(results)} 条)")

                # v2.1：收集相关帖子抽样笔记（供校验引擎使用）
                if self.notes_samples_file:
                    samples = self.extract_relevance_samples(captured)
                    if samples:
                        notes_samples.setdefault("kols", []).append({
                            "userId": user_id,
                            "name": row["达人名称"],
                            "platform": "小红书",
                            "target_tags": list(self.target_tags),
                            "relevance_keywords": list(self.relevance_keywords),
                            "samples": samples,
                        })

                # 每收集到一个匹配 KOL 就写入 CSV，防止长时间采集中断丢数据
                self.save_csv(results, output_file)

                # 每处理 5 个 KOL 保活
                if idx % 5 == 0:
                    try:
                        main_page.evaluate("1+1")
                    except Exception:
                        pass

            # ========== 3. 写入 CSV ==========
            print("\n" + "=" * 60)
            print("Step 3: 写入结果")
            print("=" * 60)

            if not results:
                print("无匹配结果，跳过写入")
                # v2.1：即使无匹配也尝试写出已采到的抽样笔记（便于排查）
                if self.notes_samples_file and notes_samples.get("kols"):
                    notes_samples["generated_at"] = datetime.datetime.now().isoformat()
                    notes_samples["count"] = len(notes_samples.get("kols", []))
                    ns_path = self.notes_samples_file
                    if not os.path.isabs(ns_path):
                        ns_path = os.path.join(os.path.dirname(os.path.abspath(output_file)), ns_path)
                    os.makedirs(os.path.dirname(os.path.abspath(ns_path)), exist_ok=True)
                    with open(ns_path, "w", encoding="utf-8") as f:
                        json.dump(notes_samples, f, ensure_ascii=False, indent=2)
                    print(f"抽样笔记已写入: {ns_path}（{notes_samples['count']} 个 KOL）")
                return results

            # 去重（本次结果内，按 userId/小红书号/名称 归一）
            seen = set()
            unique_results = []
            for r in results:
                key = r.get("userId") or r.get("小红书号") or r["达人名称"]
                if key not in seen:
                    seen.add(key)
                    unique_results.append(r)

            # 合并已有文件（v2.0.2：断点续采时本次只采增量，末尾必须合并已有行，避免整表覆写丢数据）
            merged = {}
            for r in self._load_existing_rows(output_file):
                key = r.get("userId") or r.get("小红书号") or r.get("达人名称") or ""
                if key:
                    merged[key] = r
            for r in unique_results:
                key = r.get("userId") or r.get("小红书号") or r["达人名称"]
                if key:
                    merged[key] = r
            merged_rows = list(merged.values())

            print(f"本次新增 {len(unique_results)} 条，合并已有后共 {len(merged_rows)} 条")

            with open(output_file, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.DictWriter(f, fieldnames=HEADERS)
                writer.writeheader()
                writer.writerows(merged_rows)

            print(f"CSV 已写入: {output_file}")

            if debug_file:
                debug["result_count"] = len(merged_rows)
                debug["output_file"] = output_file
                with open(debug_file, "w", encoding="utf-8") as f:
                    json.dump(debug, f, ensure_ascii=False, indent=2)

            # v2.1：写入抽样笔记 JSON（供校验引擎消费）
            if self.notes_samples_file:
                notes_samples["generated_at"] = datetime.datetime.now().isoformat()
                notes_samples["count"] = len(notes_samples.get("kols", []))
                ns_path = self.notes_samples_file
                if not os.path.isabs(ns_path):
                    ns_path = os.path.join(os.path.dirname(os.path.abspath(output_file)), ns_path)
                os.makedirs(os.path.dirname(os.path.abspath(ns_path)), exist_ok=True)
                with open(ns_path, "w", encoding="utf-8") as f:
                    json.dump(notes_samples, f, ensure_ascii=False, indent=2)
                print(f"抽样笔记已写入: {ns_path}（{notes_samples['count']} 个 KOL）")

            print(f"\n完成！共采集 {len(unique_results)} 个 KOL")
            return results

    # ----- CSV 增量写入 -----

    def save_csv(self, results, output_file):
        """把 results 中尚未写入 output_file 的行追加写入（带 BOM）。
        v2.0.2：去重键与结尾合并统一为 userId/小红书号/达人名称，且改用 csv 模块解析，
        避免旧逻辑按第一列 split(",") 去重在名称含逗号/改昵称时错位。"""
        if not results:
            return
        os.makedirs(os.path.dirname(os.path.abspath(output_file)), exist_ok=True)

        def row_key(r):
            k = r.get("userId") or r.get("小红书号") or r.get("达人名称") or ""
            return str(k).strip() if k else ""

        existing_keys = set()
        if os.path.exists(output_file) and os.path.getsize(output_file) > 0:
            try:
                with open(output_file, "r", encoding="utf-8-sig", newline="") as f:
                    for row in csv.DictReader(f):
                        k = row.get("userId") or row.get("小红书号") or row.get("达人名称") or ""
                        if k:
                            existing_keys.add(str(k).strip())
            except Exception:
                pass

        seen = set(existing_keys)
        new_rows = []
        for r in results:
            k = row_key(r)
            if k and k not in seen:
                seen.add(k)
                new_rows.append(r)
        if not new_rows:
            return
        write_header = not (os.path.exists(output_file) and os.path.getsize(output_file) > 0)
        with open(output_file, "a", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=HEADERS)
            if write_header:
                writer.writeheader()
            writer.writerows(new_rows)
        print(f"    [写入] 追加 {len(new_rows)} 条 -> {output_file}")


def check_environment(cdp_port=9222, check_login=True):
    """快速检查 Chrome CDP 是否开启、蒲公英是否已登录。供 Agent --check 使用。"""
    import urllib.request
    print(f"检查 Chrome CDP 端口 {cdp_port} ...")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/version", timeout=4) as r:
            ver = json.loads(r.read().decode("utf-8"))
        print(f"  [OK] CDP 已开启: {ver.get('Browser', '')}")
    except Exception as e:
        print(f"  [FAIL] CDP 未开启: {e}")
        print("  请先用以下命令启动带远程调试端口的 Chrome：")
        print("    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\")
        print("      --remote-debugging-port=9222 --user-data-dir=/tmp/chrome_pgy_debug")
        print("  然后在 Chrome 中登录 https://pgy.xiaohongshu.com")
        return False
    if not check_login:
        return True
    try:
        with playwright.sync_api.sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp_port}")
            context = browser.contexts[0]
            main_page = None
            for pg in context.pages:
                if "pgy.xiaohongshu.com" in pg.url:
                    main_page = pg
                    break
            if main_page is None:
                main_page = context.new_page()
                main_page.goto("https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
                               wait_until="domcontentloaded", timeout=60000)
                time.sleep(3)
            body_text = main_page.inner_text("body")
            if "账号登录" in body_text or "立即登录" in body_text:
                print("  [FAIL] 蒲公英未登录，请在 Chrome 中登录 pgy.xiaohongshu.com")
                return False
            print("  [OK] 蒲公英登录态正常")
            return True
    except Exception as e:
        print(f"  [FAIL] 连接 Chrome 检查失败: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="小红书蒲公英 KOL 通用采集器")
    parser.add_argument("--config", default="", help="config JSON 路径（筛选参数+输出路径）")
    parser.add_argument("--port", type=int, default=9222, help="Chrome CDP 端口")
    parser.add_argument("--check", action="store_true", help="仅检查 CDP 与登录态，不采集")
    parser.add_argument("--output", type=str, default="", help="输出 CSV 路径（覆盖 config 中的 output_file）")
    args = parser.parse_args()

    if args.check:
        sys.exit(0 if check_environment(args.port, check_login=True) else 1)

    if not args.config:
        print("缺少 --config 参数。示例：")
        print("  python3 kol_collector.py --config examples/config-shanghai-food-tandian.json")
        print("或先运行 --check 验证环境。")
        sys.exit(2)

    # WORKSPACE_FILES = <campaign workspace>/workspace-files（skill 目录的上两级是 workspace 根）
    skill_scripts_dir = os.path.dirname(os.path.abspath(__file__))
    workspace_root = os.path.dirname(os.path.dirname(os.path.dirname(skill_scripts_dir)))
    WORKSPACE_FILES = os.path.join(workspace_root, "workspace-files")
    os.makedirs(WORKSPACE_FILES, exist_ok=True)

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)

    output_file = args.output or cfg.get("output_file", "")
    if not output_file:
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = os.path.join(WORKSPACE_FILES, f"KOL采集结果_{ts}.csv")
    if not os.path.isabs(output_file):
        output_file = os.path.join(WORKSPACE_FILES, output_file)
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    cfg["output_file"] = output_file
    cfg["cdp_port"] = args.port

    debug_file = output_file.replace(".csv", "_debug.json")

    print("=" * 60)
    print("小红书蒲公英 KOL 通用采集器")
    print("=" * 60)
    print(f"  输出文件: {output_file}")
    print(f"  关键词:   {cfg.get('keywords')}")
    print(f"  地域:     {cfg.get('location_cities')} / 粉丝地域 {cfg.get('fans_location_cities')}")
    print(f"  粉丝量:   {cfg.get('fans_number_lower')}-{cfg.get('fans_number_upper')}")
    print(f"  报价:     {cfg.get('note_price_lower')}-{cfg.get('note_price_upper')} 元")
    print(f"  内容标签: {cfg.get('target_tags')}  类目: {cfg.get('first_industry')}/{cfg.get('second_industry')}")
    print(f"  CDP 端口: {args.port}")
    print("=" * 60)
    print()

    collector = KolCollector(cfg)
    collector.run(output_file, debug_file)


if __name__ == "__main__":
    main()
