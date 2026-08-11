#!/usr/bin/env python3
"""小红书蒲公英 母婴/育儿 KOL 采集器（北京，5000-50000粉丝，报价2000-8000）

原理：
  - 通过 playwright.connect_over_cdp 连接到用户正在使用的真实 Chrome 浏览器
  - 搜索 API 通过 page.evaluate() 在浏览器 JS 上下文中用 fetch() 执行，
    前端代码自动附带正确的 x-s / x-t 签名参数
  - 详情页数据通过导航到 KOL 详情页 + on("response") 监听捕获

用法：
  1. 启动 Chrome 远程调试端口：Google Chrome 已打开 --remote-debugging-port=9222
  2. 在 Chrome 中手动登录小红书蒲公英（https://pgy.xiaohongshu.com）
  3. 运行本脚本：python3 collect_maternal_kol.py

输出：
  母婴育儿博主_北京_采集结果.csv
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
    "预估CPM", "预估CPE", "数据来源",
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
            continue
        t1 = tag.get("taxonomy1Tag", "")
        t2s = tag.get("taxonomy2Tags", []) or []
        if t1 and t2s:
            parts.append(f"{t1}({','.join(t2s)})")
        elif t1:
            parts.append(t1)
    return ";".join(parts)


def format_location_cities(cities):
    result = []
    for city in (cities or []):
        result.append(f"中国 {city}")
    return result


def parse_publish_time(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        if ts > 1e12:
            ts /= 1000
        if ts > 1e9:
            return datetime.datetime.fromtimestamp(ts)
    if isinstance(ts, str):
        for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d", "%Y/%m/%d %H:%M:%S"):
            try:
                return datetime.datetime.strptime(ts[:len(fmt)], fmt)
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

class MaternalKolCollector:
    """小红书蒲公英 母婴/育儿 KOL 采集器"""

    def __init__(self, cfg):
        self.cfg = cfg
        self.brand_user_id = cfg.get("brand_user_id", "")
        self.keywords = cfg.get("keywords", [])
        self.gender = cfg.get("gender", "女")
        self.location_cities = format_location_cities(cfg.get("location_cities", ["北京"]))
        self.fans_location_cities = format_location_cities(cfg.get("fans_location_cities", ["北京"]))
        self.target_cities = set(cfg.get("target_cities", ["北京"]))
        self.target_tags = set(cfg.get("target_tags", ["母婴", "育儿"]))
        self.trade_type = cfg.get("trade_type", "不限")
        self.price_lower = cfg.get("note_price_lower", 2000)
        self.price_upper = cfg.get("note_price_upper", 8000)
        self.fans_lower = cfg.get("fans_number_lower", 5000)
        self.fans_upper = cfg.get("fans_number_upper", 50000)
        self.cdp_port = cfg.get("cdp_port", 9222)
        self.max_pages = cfg.get("max_pages", 20)
        self.coop_note_months = cfg.get("coop_note_months", 3)
        self.coop_note_pages_max = cfg.get("coop_note_pages_max", 10)
        self.output_file = cfg.get("output_file", "")
        self.max_kols = cfg.get("max_kols", 0)

    # ----- 过滤方法 -----

    def kol_matches_location(self, kol):
        loc = kol.get("location") or ""
        for city in self.target_cities:
            if loc.startswith(city) or loc == city:
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

    def kol_matches_content_tags(self, kol):
        """检查内容标签是否包含母婴/育儿相关标签"""
        tags = set()
        for tag in kol.get("contentTags") or []:
            if isinstance(tag, dict):
                tags.add(tag.get("taxonomy1Tag", ""))
                tags.update(tag.get("taxonomy2Tags", []) or [])
        tags.update(kol.get("featureTags") or [])
        tags.update(kol.get("personalTags") or [])

        # 母婴/育儿相关标签
        maternal_tags = {"母婴", "育儿", "母婴用品", "孕产", "亲子", "早教",
                         "宝宝", "儿童", "辅食", "婴儿", "新生儿", "孕期"}
        return bool(maternal_tags & tags)

    def fan_profile_matches(self, fans_profile):
        cities = safe_get(fans_profile, "data", "cities", default=[]) or []
        top5 = [c.get("name", "") for c in cities[:5]]
        for c in top5:
            for tc in self.target_cities:
                if tc in c:
                    return True, top5
        return False, top5

    def is_active_recently(self, notes_rate, blogger=None, days=15):
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
        valid = [n for n in coop if (n.get("impNum") or n.get("imp") or 0) > 0]
        if valid:
            return min(valid, key=lambda x: x.get("impNum") or x.get("imp") or float("inf"))
        return None

    def get_min_like_coop_note(self, all_notes):
        coop = self._coop_notes_within_months(all_notes)
        if not coop:
            return None
        return min(coop, key=lambda x: x.get("likeNum") or x.get("like") or float("inf"))

    # ----- 搜索 API -----

    def fetch_search_kols(self, page):
        """分页拉取搜索列表"""
        payload = {
            "searchType": 1, "column": "comprehensiverank", "sort": "desc",
            "pageNum": 1, "pageSize": 20,
            "brandUserId": self.brand_user_id,
            "trackId": f"kolMatch_{uuid.uuid4().hex}",
            "keyword": None,
            "gender": self.gender,
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
            "firstIndustry": "", "secondIndustry": "", "newHighQuality": 0,
            "filterIntention": False,
            "flagList": [{"flagType": "HAS_BRAND_COOP_BUYER_AUTH", "flagValue": "0"},
                         {"flagType": "IS_HIGH_QUALITY", "flagValue": "0"}],
            "activityCodes": [], "excludeLowActive": False, "fansNumUp": 0,
            "excludedTradeReportBrand": False, "excludedTradeInviteReportBrand": False,
            "filterList": [], "contentSceneLabel": [],
        }

        # 先尝试用关键词搜索（母婴、育儿）
        all_kols_dict = {}  # userId -> kol

        for keyword in self.keywords:
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

            for kol in kols:
                uid = kol.get("userId")
                if uid:
                    all_kols_dict[uid] = kol

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

                # 检查时间范围
                all_old = True
                for note in new_notes:
                    if note.get("isAdvertise"):
                        dt = parse_publish_time(note.get("date") or note.get("publishTime"))
                        if dt and dt >= pull_cutoff:
                            all_old = False
                            break
                if all_old:
                    break

                page_coop = [n for n in new_notes if n.get("isAdvertise")]
                if not page_coop:
                    continue

                # 提取抽屉数据
                for ci in range(len(page_coop)):
                    note = page_coop[ci]
                    nid = note.get("noteId")
                    if nid and nid in note_exposure:
                        continue

                    clicked = detail_page.evaluate(
                        """({idx}) => {
                            const cards = document.querySelectorAll('.note-card-wrapper, [class*=note-card], [class*=noteCard]');
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
                        const ex = (label) => {
                            for(let i=0;i<lines.length;i++){
                                if(lines[i]===label || lines[i].startsWith(label)){
                                    const next = lines[i+1];
                                    if (next) {
                                        const n = parseInt(next.replace(/,/g,''));
                                        if (!isNaN(n)) return n;
                                    }
                                }
                            }
                            return null;
                        };
                        return {
                            title: lines[0]||'',
                            exposure: ex('曝光量') || ex('曝光'),
                            reads: ex('阅读量') || ex('阅读'),
                            likes: ex('点赞量') || ex('点赞'),
                            favorites: ex('收藏量') || ex('收藏'),
                            comments: ex('评论量') || ex('评论'),
                        };
                    }""")

                    if drawer_data and drawer_data.get("exposure"):
                        note_exposure[nid] = drawer_data["exposure"]
                        for k2, kk in (("reads", "readNum"), ("likes", "likeNum"),
                                       ("favorites", "collectNum"), ("comments", "commentNum")):
                            if drawer_data.get(k2):
                                note_exposure[f"{nid}_{kk}"] = drawer_data[k2]

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

        finally:
            detail_page.remove_listener("response", on_resp)
            detail_page.close()

        return captured

    # ----- 构建 CSV 行 -----

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

        # 注入抽屉数据
        note_exposure = captured.get("note_exposure") or {}
        for note in all_detail_notes:
            nid = note.get("noteId")
            if nid and nid in note_exposure:
                note["impNum"] = note_exposure[nid]
                for sfx, key in [("_reads", "readNum"), ("_likes", "likeNum"),
                                 ("_favorites", "collectNum"), ("_comments", "commentNum")]:
                    if f"{nid}{sfx}" in note_exposure:
                        note[key] = note_exposure[f"{nid}{sfx}"]

        min_imp_note = self.get_min_imp_coop_note(all_detail_notes)
        min_like_note = self.get_min_like_coop_note(all_detail_notes)

        # 计算 CPM / CPE
        cpm = None
        cpe = None
        if effective_price:
            if min_imp_note:
                imp = min_imp_note.get("impNum") or min_imp_note.get("imp") or 0
                if imp:
                    cpm = effective_price / imp * 1000
            if cpm is None:
                coop_imp_median = safe_get(notes_rate_coop, "data", "impMedian", default=None)
                if coop_imp_median and coop_imp_median > 0:
                    cpm = effective_price / coop_imp_median * 1000
            if min_like_note:
                like = min_like_note.get("likeNum") or min_like_note.get("like") or 0
                if like:
                    cpe = effective_price / like

        def nr_median(nr, key):
            return safe_get(nr, "data", key, default=None)

        def note_field(note, key, fallback_keys=None):
            if not note:
                return None
            for k in ([key] + (fallback_keys or [])):
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
            feature_tag_str = ";".join(feature_tag_list)
        else:
            feature_tag_str = str(feature_tag_list) if feature_tag_list else ""

        return {
            "达人名称": blogger.get("name") or kol.get("name") or "",
            "小红书号": blogger.get("xiaohongshuId") or kol.get("xiaohongshuId") or kol.get("userId") or "",
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
            "合作笔记最低曝光": note_field(min_imp_note, "impNum", ["imp"]),
            "合作笔记最低曝光阅读": note_field(min_imp_note, "readNum", ["read"]),
            "合作笔记最低曝光点赞": note_field(min_imp_note, "likeNum", ["like"]),
            "合作笔记最低曝光收藏": note_field(min_imp_note, "collectNum", ["collect"]),
            "合作笔记最低曝光评论": note_field(min_imp_note, "commentNum", ["comment"]),
            "合作笔记最低曝光时间": min_imp_note.get("date") if min_imp_note else None,
            "合作笔记最低点赞": note_field(min_like_note, "likeNum", ["like"]),
            "合作笔记最低点赞阅读": note_field(min_like_note, "readNum", ["read"]),
            "合作笔记最低点赞收藏": note_field(min_like_note, "collectNum", ["collect"]),
            "合作笔记最低点赞评论": note_field(min_like_note, "commentNum", ["comment"]),
            "合作笔记最低点赞时间": min_like_note.get("date") if min_like_note else None,
            "内容标签": content_tag_str,
            "擅长标签": feature_tag_str,
            "预估CPM": round(cpm, 2) if cpm is not None else None,
            "预估CPE": round(cpe, 2) if cpe is not None else None,
            "数据来源": "蒲公英",
        }

    # ----- 主流程 -----

    def run(self, output_file, debug_file=None):
        results = []
        debug = {"errors": [], "filtered_in": [], "filtered_out": []}

        cdp_url = f"http://127.0.0.1:{self.cdp_port}"

        with playwright.sync_api.sync_playwright() as p:
            print(f"正在连接 Chrome CDP: {cdp_url}")
            print("请确保：")
            print("  1. Chrome 已打开远程调试端口（--remote-debugging-port=9222）")
            print("  2. 已登录小红书蒲公英（pgy.xiaohongshu.com）")
            print()
            browser = p.chromium.connect_over_cdp(cdp_url)
            context = browser.contexts[0]

            # 找到可用的主页面
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

            # 确保在蒲公英列表页
            if "/solar/pre-trade/note/kol" not in main_page.url:
                print("导航至蒲公英笔记博主广场...")
                main_page.goto(
                    "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
                    wait_until="domcontentloaded", timeout=60000
                )
                time.sleep(3)

            # 检查登录态
            try:
                body_text = main_page.inner_text("body")
                if "账号登录" in body_text or "立即登录" in body_text:
                    print("\n未检测到登录态！请在 Chrome 中手动登录蒲公英后按 Enter 继续...")
                    input("按 Enter 继续...")
                    main_page.goto(
                        "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
                        wait_until="domcontentloaded", timeout=60000
                    )
                    time.sleep(3)
                    body_text = main_page.inner_text("body")
                    if "账号登录" in body_text or "立即登录" in body_text:
                        print("登录态仍未检测到，退出。")
                        return results
            except Exception:
                print("检查登录态时异常，继续...")

            print("登录态正常")

            # ========== 1. 搜索列表 ==========
            print("\n" + "=" * 60)
            print("Step 1: 搜索母婴/育儿 KOL")
            print(f"筛选条件：北京 / 粉丝{self.fans_lower}-{self.fans_upper} / 报价{self.price_lower}-{self.price_upper}")
            print(f"关键词：{self.keywords}")
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

            for idx, kol in enumerate(candidates, start=1):
                user_id = kol.get("userId")
                name = kol.get("name") or ""
                print(f"\n[{idx}/{len(candidates)}] {name} (userId={user_id})")

                # 打开详情页采集
                try:
                    captured = self.fetch_kol_detail(context, user_id)
                except Exception as e:
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
                    print(f"  -> 过滤: 标签不含母婴/育儿")
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
                    print(f"  -> 过滤: 粉丝地域不含北京 (top5={top5_cities})")
                    debug["filtered_out"].append({"name": name, "reason": "fan_city"})
                    continue

                # 构建数据行
                row = self.build_row(kol, blogger, captured, top5_cities, fans_profile)
                results.append(row)
                debug["filtered_in"].append({"name": row["达人名称"], "userId": user_id})
                print(f"  -> MATCH: {row['达人名称']} (累计 {len(results)} 条)")

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
                return results

            # 去重
            seen_names = set()
            unique_results = []
            for r in results:
                name = r["达人名称"]
                if name not in seen_names:
                    seen_names.add(name)
                    unique_results.append(r)

            print(f"共 {len(results)} 条结果，去重后 {len(unique_results)} 条")

            with open(output_file, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.DictWriter(f, fieldnames=HEADERS)
                writer.writeheader()
                writer.writerows(unique_results)

            print(f"CSV 已写入: {output_file}")

            if debug_file:
                debug["result_count"] = len(unique_results)
                debug["output_file"] = output_file
                with open(debug_file, "w", encoding="utf-8") as f:
                    json.dump(debug, f, ensure_ascii=False, indent=2)

            print(f"\n完成！共采集 {len(unique_results)} 个母婴/育儿 KOL")
            return results


def main():
    parser = argparse.ArgumentParser(description="小红书蒲公英 母婴/育儿 KOL 采集器")
    parser.add_argument("--port", type=int, default=9222, help="Chrome CDP 端口")
    parser.add_argument("--output", type=str, default="",
                        help="输出 CSV 路径（默认自动生成到 outputs 目录）")
    parser.add_argument("--max", type=int, default=0, help="最大采集数量，0=不限")
    parser.add_argument("--pages", type=int, default=20, help="搜索最大翻页数")
    args = parser.parse_args()

    # 默认输出路径（用户指定的绝对路径）
    default_output_dir = "/Users/xuxuwen/.mapro-dev/agent-workspaces/Users/xuxuwen/Desktop/蒲公英kol筛选/skills/ma-kol-scraper-workspace/iteration-1/eval-2/without_skill/outputs"

    output_file = args.output
    if not output_file:
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = os.path.join(default_output_dir, f"母婴育儿博主_北京_{timestamp}.csv")

    debug_file = output_file.replace(".csv", "_debug.json")

    # 确保输出目录存在
    os.makedirs(os.path.dirname(output_file), exist_ok=True)

    # 配置
    cfg = {
        "brand_user_id": "",
        "keywords": ["母婴", "育儿", "母婴用品", "亲子", "孕产"],
        "gender": "女",
        "location_cities": ["北京"],
        "fans_location_cities": ["北京"],
        "target_cities": ["北京"],
        "target_tags": ["母婴", "育儿"],
        "trade_type": "不限",
        "note_price_lower": 2000,
        "note_price_upper": 8000,
        "fans_number_lower": 5000,
        "fans_number_upper": 50000,
        "cdp_port": args.port,
        "max_pages": args.pages,
        "max_kols": args.max,
        "coop_note_months": 3,
        "coop_note_pages_max": 10,
        "output_file": output_file,
    }

    print("=" * 60)
    print("小红书蒲公英 KOL 采集器")
    print("专项：北京母婴/育儿博主")
    print("=" * 60)
    print(f"  输出文件: {output_file}")
    print(f"  筛选条件:")
    print(f"    - 地域: 北京")
    print(f"    - 粉丝量: 5000-50000")
    print(f"    - 报价: 2000-8000 元")
    print(f"    - 内容标签: 母婴, 育儿, 母婴用品, 亲子, 孕产")
    print(f"    - CDP 端口: {args.port}")
    print(f"    - 最大翻页: {args.pages}")
    if args.max > 0:
        print(f"    - 最大数量: {args.max}")
    print(f"  搜索关键词: {cfg['keywords']}")
    print("=" * 60)
    print()

    collector = MaternalKolCollector(cfg)
    collector.run(output_file, debug_file)


if __name__ == "__main__":
    main()
