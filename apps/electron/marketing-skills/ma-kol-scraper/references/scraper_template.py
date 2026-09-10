#!/usr/bin/env python3
"""
蒲公英 KOL 采集器 - 模板参考脚本

本脚本是 ma-kol-scraper skill 的代码参考模板，展示了完整的采集器结构。
生成定制化脚本时参考此模板的模式和实现细节。

基于 collect_pgy_v4.py / collect_kol_data.py / collect_v3.py 的成熟模式。
所有产出文件写入 WORKSPACE_FILES 目录（工作区文件目录），
不受会话工作目录变更影响。
"""
import csv, datetime, json, os, sys, time, uuid, argparse, traceback
import playwright.sync_api

# 工作区文件目录（所有产出写入此处，不依赖当前工作目录）
WORKSPACE_FILES = "<workspace-files-dir>"
os.makedirs(WORKSPACE_FILES, exist_ok=True)

# ==================== 表头 ====================
HEADERS = [
    "达人名称", "内容类目", "地域", "粉丝量", "粉丝所在区域（前五城市）", "获赞与收藏",
    "图文报价（万）", "视频报价（万）", "女性粉丝占比",
    "日常笔记发布篇数", "日常笔记曝光中位数", "日常笔记阅读中位数", "日常笔记点赞中位数",
    "合作笔记发布篇数", "合作笔记曝光中位数", "合作笔记阅读中位数", "合作笔记点赞中位数",
    "合作笔记最低曝光", "合作笔记最低曝光阅读", "合作笔记最低曝光点赞",
    "合作笔记最低曝光收藏", "合作笔记最低曝光评论", "合作笔记最低曝光时间",
    "合作笔记最低点赞", "合作笔记最低点赞阅读", "合作笔记最低点赞收藏",
    "合作笔记最低点赞评论", "合作笔记最低点赞时间",
    "预估CPM", "预估CPE",
]

# ==================== 辅助函数 ====================

def safe_get(obj, *keys, default=None):
    """安全地获取嵌套字典值"""
    for key in keys:
        if not isinstance(obj, dict):
            return default
        obj = obj.get(key, default)
    return obj


def format_content_tags(content_tags):
    """格式化内容类目标签为可读字符串"""
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
    """格式化城市为 API 需要的 '中国 省市' 格式"""
    result = []
    for city in (cities or []):
        if city in ("北京", "上海", "天津", "重庆"):
            result.append(f"中国 {city}")
        elif city in ("深圳", "广州"):
            result.append(f"中国 广东 {city}")
        elif city in ("杭州", "宁波"):
            result.append(f"中国 浙江 {city}")
        elif city in ("成都",):
            result.append(f"中国 四川 {city}")
        else:
            result.append(f"中国 {city}")
    return result


def parse_publish_time(ts):
    """解析多种格式的发布时间戳"""
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
                # 注意: 不能用 ts[:len(fmt)] 截断，因为 %Y 在格式串中占2字符但实际占4位
                return datetime.datetime.strptime(ts, fmt)
            except Exception:
                continue
    return None


def js_fetch_json(url, method="GET", body=None):
    """在浏览器 JS 上下文中用 fetch 发送请求（自动携带签名）"""
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


# ==================== 采集器主类 ====================

class PgyCollector:
    """蒲公英 KOL 采集器"""

    def __init__(self, cfg):
        """初始化配置"""
        self.cfg = cfg
        self.brand_user_id = cfg["brand_user_id"]
        self.keyword = cfg.get("keyword", "")
        self.gender = cfg["gender"]
        self.location_cities = format_location_cities(cfg.get("location_cities", []))
        self.fans_location_cities = format_location_cities(cfg.get("fans_location_cities", []))
        self.target_cities = set(cfg.get("target_cities", []))
        self.target_tags = set(cfg.get("target_tags", []))
        self.price_lower = cfg["note_price_lower"]      # 单位：元
        self.price_upper = cfg["note_price_upper"]      # 单位：元
        self.fans_lower = cfg["fans_number_lower"]
        self.fans_upper = cfg["fans_number_upper"]
        self.cdp_port = cfg.get("cdp_port", 9222)
        self.max_pages = cfg.get("max_pages", 40)
        self.max_kols = cfg.get("max_kols", 0)
        self.active_within_days = cfg.get("active_within_days", 10)
        self.water_read_like_ratio_min = cfg.get("water_read_like_ratio_min", 11.43)
        self.water_read_like_ratio_max = cfg.get("water_read_like_ratio_max", 30.0)
        self.coop_note_months = cfg.get("coop_note_months", 3)
        self.coop_note_pages_max = cfg.get("coop_note_pages_max", 20)
        self.trade_type = cfg.get("trade_type", "美妆个护")

    # ==================== 过滤方法 ====================

    def kol_matches_location(self, kol, debug_name=None):
        """博主地域匹配目标城市列表中的任意一个"""
        target_cities = self.target_cities
        if not target_cities:
            return True

        loc = kol.get("location") or ""
        loc_str = str(loc).strip()

        for city in target_cities:
            if loc_str.startswith(city) or loc_str == city:
                return True

        # travelAreaList 兜底
        travel = kol.get("travelAreaList") or []
        if isinstance(travel, list):
            for area in travel:
                if isinstance(area, str):
                    for city in target_cities:
                        if city in area:
                            return True
                if isinstance(area, dict):
                    for val in area.values():
                        if isinstance(val, str):
                            for city in target_cities:
                                if city in val:
                                    return True

        if debug_name:
            print(f"  [地域过滤] {debug_name}: '{loc_str}' -> 不匹配")
        return False

    def kol_matches_price(self, kol):
        """合作报价在指定范围内"""
        for price in (kol.get("picturePrice"), kol.get("videoPrice")):
            if price is None:
                continue
            if self.price_lower <= price <= self.price_upper:
                return True
        return False

    def kol_matches_fans(self, kol):
        """粉丝量在指定范围内"""
        fans = kol.get("fansCount") or kol.get("fansNum") or 0
        return self.fans_lower <= fans <= self.fans_upper

    def kol_matches_content_tags(self, kol):
        """内容标签匹配目标标签"""
        cts = []
        for tag in kol.get("contentTags") or []:
            if isinstance(tag, dict):
                cts.append(tag.get("taxonomy1Tag", ""))
                cts.extend(tag.get("taxonomy2Tags", []) or [])
        fts = kol.get("featureTags") or []
        if not isinstance(fts, list):
            fts = []
        pts = kol.get("personalTags") or []
        if not isinstance(pts, list):
            pts = []

        if self.target_tags:
            for tag in self.target_tags:
                if tag in cts or tag in fts or tag in pts:
                    return True
        else:
            return True
        return False

    def fan_profile_matches(self, fans_profile):
        """粉丝地域需包含目标城市之一（前五城市）"""
        cities = safe_get(fans_profile, "data", "cities", default=[]) or []
        top5 = [c.get("name", "") for c in cities[:5]]
        target_cities = self.target_cities
        if not target_cities:
            return True, top5
        has_target = any(any(tc in c for tc in target_cities) for c in top5)
        return has_target, top5

    def is_active_recently(self, notes_rate, blogger=None):
        """近 N 天有更新"""
        notes = safe_get(notes_rate, "data", "notes", default=[]) or []
        if not notes and blogger:
            last_time = blogger.get("lastNoteTime")
            if last_time:
                dt = parse_publish_time(last_time)
                if dt:
                    return (datetime.datetime.now() - dt).days <= self.active_within_days
        if not notes:
            return True
        cutoff = datetime.datetime.now() - datetime.timedelta(days=self.active_within_days)
        for note in notes:
            dt = parse_publish_time(note.get("publishTime"))
            if dt and dt >= cutoff:
                return True
        return False

    def is_water_account(self, notes_rate):
        """水号检测：阅读/点赞比例异常"""
        read_median = safe_get(notes_rate, "data", "readMedian", default=None)
        like_median = safe_get(notes_rate, "data", "likeMedian", default=None)
        if not read_median or not like_median or like_median == 0:
            return False
        ratio = read_median / like_median
        is_normal = self.water_read_like_ratio_min <= ratio <= self.water_read_like_ratio_max
        return not is_normal

    def _coop_notes_within_months(self, all_notes):
        """筛选近 N 个月的合作笔记"""
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
        """从合作笔记中找最低曝光"""
        coop = self._coop_notes_within_months(all_notes)
        if not coop:
            return None
        valid = [n for n in coop if (n.get("impNum") or n.get("imp") or 0) > 0]
        if valid:
            return min(valid, key=lambda x: x.get("impNum") or x.get("imp") or float("inf"))
        return None

    def get_min_like_coop_note(self, all_notes):
        """从合作笔记中找最低点赞"""
        coop = self._coop_notes_within_months(all_notes)
        if not coop:
            return None
        return min(coop, key=lambda x: x.get("likeNum") or x.get("like") or float("inf"))

    # ==================== 搜索列表 ====================

    def fetch_search_kols(self, page):
        """分页拉取搜索列表"""
        payload = {
            "searchType": 1, "column": "comprehensiverank", "sort": "desc",
            "pageNum": 1, "pageSize": 20,
            "brandUserId": self.brand_user_id,
            "trackId": f"kolMatch_{uuid.uuid4().hex}",
            "keyword": self.keyword if self.keyword else None,
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

        js_code = js_fetch_json(
            "https://pgy.xiaohongshu.com/api/solar/cooperator/blogger/v2",
            method="POST", body=payload
        )
        data = page.evaluate(js_code)
        if not data:
            raise RuntimeError("搜索接口无返回，请检查登录态是否有效。")
        code = data.get("code")
        if code != 0:
            raise RuntimeError(f"搜索接口返回 code={code}, msg={data.get('msg', '')}")

        total = safe_get(data, "data", "total", default=0) or 0
        kols = safe_get(data, "data", "kols", default=[]) or []
        print(f"  第1页 total={total} 返回={len(kols)}")

        all_kols = list(kols)
        page_num = 2
        max_retries = 3
        while page_num <= self.max_pages and len(all_kols) < (self.max_kols if self.max_kols > 0 else total):
            retry = 0
            fetched = False
            while retry < max_retries:
                try:
                    payload["pageNum"] = page_num
                    payload["trackId"] = f"kolMatch_{uuid.uuid4().hex}"
                    data = page.evaluate(js_fetch_json(
                        "https://pgy.xiaohongshu.com/api/solar/cooperator/blogger/v2",
                        method="POST", body=payload
                    ))
                    if data and data.get("code") == 0:
                        kols = safe_get(data, "data", "kols", default=[]) or []
                        all_kols.extend(kols)
                        print(f"  第{page_num}页 返回={len(kols)} 累计={len(all_kols)}")
                        fetched = True
                        break
                    else:
                        retry += 1
                        time.sleep(2)
                except Exception as e:
                    retry += 1
                    time.sleep(3)
            if not fetched:
                print(f"  第{page_num}页重试{max_retries}次仍失败，停止翻页")
                break
            page_num += 1
            time.sleep(0.5)
            if page_num % 5 == 0:  # 保活
                try:
                    page.evaluate("1+1")
                except Exception:
                    break

        return all_kols

    # ==================== 详情页采集 ====================

    def fetch_kol_detail(self, context, user_id, prev_page=None):
        """
        在新标签页中打开 KOL 详情页，on_response 捕获基础 API 数据

        采集内容：
        1. blogger API（达人基础信息）
        2. fans_profile API（粉丝画像）
        3. notes_rate API（日常笔记/合作笔记 × 仅自然流量/全流量）
        4. notes_detail API（笔记案例 tab 首页数据）

        不包含翻页+抽屉提取（由 extract_coop_notes 单独完成）。
        
        prev_page: 上一个详情页(page对象)，打开新页面前关闭
        """
        if prev_page is not None:
            try:
                prev_page.close()
            except Exception:
                pass

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
                    print(f"      [API捕获] {key}")
                elif "/api/solar/kol/data_v2/notes_detail" in url and f"userId={user_id}" in url:
                    data = resp.json()
                    notes = safe_get(data, "data", "list", default=[]) or []
                    if notes:
                        captured["notes_detail"].append(data)
                        print(f"      [API捕获] notes_detail 第{len(captured['notes_detail'])}页 {len(notes)}条")
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
                    const tabs = document.querySelectorAll('.d-tabs-header-label, .d-tab-header-space *');
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
                detail_page.evaluate("""() => {
                    const spans = document.querySelectorAll('span.d-select-wrapper, .d-select');
                    for (const s of spans) {
                        const txt = s.textContent.trim();
                        if (txt === '全流量') {
                            const rect = s.getBoundingClientRect();
                            if (rect.top > 1500) { s.click(); return true; }
                        }
                    }
                    return false;
                }""")
                time.sleep(1.5)
                detail_page.evaluate("""() => {
                    const items = document.querySelectorAll('.d-dropdown-item, .d-select-option, .d-dropdown-content div');
                    for (const item of items) {
                        if (item.textContent.trim() === '仅自然流量') { item.click(); return true; }
                    }
                    return false;
                }""")
                time.sleep(2)
            except Exception:
                pass

            # 点击"日常笔记"和"合作笔记"
            for lbl in ("日常笔记", "合作笔记"):
                try:
                    detail_page.evaluate("""({l}) => {
                        const btns = Array.from(document.querySelectorAll('button'));
                        for (const b of btns) {
                            if (b.textContent.trim() === l) {
                                const rect = b.getBoundingClientRect();
                                if (rect.top > 1500) { b.click(); return true; }
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
                    const tabs = document.querySelectorAll('.d-tabs-header-label, .d-tab-header-space *');
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
                    const segs = document.querySelectorAll('.d-segment-item');
                    const allCoop = Array.from(segs).filter(el => el.textContent.trim() === '合作笔记');
                    const coop = allCoop.length >= 2 ? allCoop[1] : allCoop[0];
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

            # ===== API 兜底（基础数据未捕获时主动 fetch） =====
            if not any(k.startswith("notes_rate_") for k in captured):
                print(f"      [兜底] 主动fetch notes_rate...")
                for business, label in ((0, "daily"), (1, "coop")):
                    for adv_sw, suffix in ((0, "organic"), (1, "all")):
                        key = f"notes_rate_{label}_{suffix}"
                        if key not in captured:
                            try:
                                url = (f"https://pgy.xiaohongshu.com/api/solar/kol/data_v3/notes_rate"
                                       f"?userId={user_id}&business={business}&advertiseSwitch={adv_sw}&pageSize=50&pageNum=1")
                                data = detail_page.evaluate(js_fetch_json(url))
                                if data and data.get("code") == 0:
                                    captured[key] = data
                            except Exception:
                                pass

            if not captured.get("notes_detail"):
                print(f"      [兜底] 主动fetch notes_detail...")
                for business in (1, 0):
                    try:
                        url = (f"https://pgy.xiaohongshu.com/api/solar/kol/data_v2/notes_detail"
                               f"?userId={user_id}&business={business}&pageNum=1&pageSize=20")
                        data = detail_page.evaluate(js_fetch_json(url))
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
            if prev_page is not detail_page:  # 不要重复关闭
                try:
                    detail_page.close()
                except Exception:
                    pass

        return captured, detail_page

    def extract_coop_notes(self, context, user_id, prev_page=None):
        """
        在 KOL 详情页的笔记案例 tab 中执行翻页 + 抽屉提取合作笔记最低数据。

        只在 fetch_kol_detail（基础采集）+ 轻量检查通过后调用。
        导航到详情页 → 笔记案例 tab → 合作笔记 segment → 翻页 + 逐条抽屉提取。

        prev_page: 上一个详情页(page对象)，打开新页面前关闭
        """
        if prev_page is not None:
            try:
                prev_page.close()
            except Exception:
                pass

        captured = {"notes_detail": []}
        detail_page = context.new_page()

        def on_resp_notes(resp):
            url = resp.url
            try:
                if resp.status != 200:
                    return
                if "/api/solar/kol/data_v2/notes_detail" in url and f"userId={user_id}" in url:
                    data = resp.json()
                    notes = safe_get(data, "data", "list", default=[]) or []
                    if notes:
                        captured["notes_detail"].append(data)
                        print(f"      [API捕获] notes_detail 第{len(captured['notes_detail'])}页 {len(notes)}条")
            except Exception:
                pass

        detail_page.on("response", on_resp_notes)

        try:
            # 1. 导航至详情页（快速加载，只需笔记案例 tab）
            detail_url = f"https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/{user_id}"
            detail_page.goto(detail_url, wait_until="domcontentloaded", timeout=30000)
            time.sleep(3)

            # 关闭弹窗
            try:
                detail_page.evaluate(
                    "() => { const el=document.querySelector('.d-modal-close'); if(el) el.click(); }"
                )
                time.sleep(1)
            except Exception:
                pass

            # 2. 点击「笔记案例」tab
            try:
                detail_page.evaluate("window.scrollTo(0, 0)")
                time.sleep(0.3)
                detail_page.evaluate("""() => {
                    const tabs = document.querySelectorAll('.d-tabs-header-label, .d-tab-header-space *');
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

            # 3. 筛选「合作笔记」segment
            try:
                detail_page.evaluate("""() => {
                    const segs = document.querySelectorAll('.d-segment-item');
                    const allCoop = Array.from(segs).filter(el => el.textContent.trim() === '合作笔记');
                    const coop = allCoop.length >= 2 ? allCoop[1] : allCoop[0];
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

            # 4. 翻页 + 抽屉提取
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
                            const pages = document.querySelectorAll('.d-pagination-page');
                            const found = Array.from(pages).find(el => {
                                const span = el.querySelector('.d-text');
                                return (span ? span.textContent.trim() : el.textContent.trim()) === String(pnum);
                            });
                            if (found) { found.scrollIntoView({block: 'center'}); found.click(); return true; }
                            return false;
                        }""",
                        {"pnum": pg},
                    )
                    if not clicked:
                        print(f"      [翻页] 第{pg}页无页码按钮，停止")
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

                all_old = True
                for note in new_notes:
                    if note.get("isAdvertise"):
                        dt = parse_publish_time(note.get("date") or note.get("publishTime"))
                        if dt and dt >= pull_cutoff:
                            all_old = False
                            break
                if all_old:
                    print(f"      [翻页] 第{pg}页笔记均超过{self.coop_note_months}个月，停止")
                    break

                page_coop = [n for n in new_notes if n.get("isAdvertise")]
                if not page_coop:
                    print(f"      [翻页] 第{pg}页无合作笔记")
                    continue

                print(f"      [抽屉] 第{pg}页有{len(page_coop)}条合作笔记")

                for ci in range(len(page_coop)):
                    note = page_coop[ci]
                    nid = note.get("noteId")
                    if nid and nid in note_exposure:
                        continue

                    ntitle = (note.get("title") or "").strip()[:20]

                    clicked = detail_page.evaluate(
                        """({title_fragment}) => {
                            const cards = document.querySelectorAll('.note-card-wrapper, [class*=note-card]');
                            let found = null;
                            for (const card of cards) {
                                if (card.hasAttribute('data-scraped')) continue;
                                const titleEl = card.querySelector('.note-card__title, [class*=title]');
                                const cardTitle = (titleEl || card).textContent.trim();
                                if (cardTitle.includes(title_fragment) || title_fragment.includes(cardTitle.slice(0, 10))) {
                                    const mask = card.querySelector('.note-card__mask, [class*=mask]');
                                    if (mask) { mask.scrollIntoView({block: 'center'}); mask.click(); }
                                    else { card.scrollIntoView({block: 'center'}); card.click(); }
                                    card.setAttribute('data-scraped', '1');
                                    return cardTitle.slice(0, 20);
                                }
                            }
                            // fallback: click first unscraped card
                            for (const card of cards) {
                                if (!card.hasAttribute('data-scraped')) {
                                    const mask = card.querySelector('.note-card__mask, [class*=mask]');
                                    if (mask) { mask.scrollIntoView({block: 'center'}); mask.click(); }
                                    else { card.scrollIntoView({block: 'center'}); card.click(); }
                                    card.setAttribute('data-scraped', '1');
                                    return (card.querySelector('.note-card__title, [class*=title]') || card).textContent.trim().slice(0, 20);
                                }
                            }
                            return null;
                        }""",
                        {"title_fragment": ntitle},
                    )
                    if not clicked:
                        print(f"        [跳过] 未找到 '{ntitle}' 对应的卡片")
                        continue
                    print(f"        [点击] 第{ci+1}条 '{clicked}'...")
                    time.sleep(2.5)

                    drawer_data = detail_page.evaluate("""() => {
                        let c = document.querySelector('.d-drawer-content, [class*=drawer-content]');
                        if (!c) return null;
                        const lines = c.innerText.split('\\n').map(l=>l.trim()).filter(l=>l);
                        const ex = (label) => {
                            for(let i=0;i<lines.length;i++){
                                if(lines[i]===label || lines[i].startsWith(label)){
                                    const next = lines[i+1];
                                    if (next) { const n = parseInt(next.replace(/,/g,'')); if (!isNaN(n)) return n; }
                                }
                            }
                            return null;
                        };
                        return {
                            title: lines[0]||'', exposure: ex('曝光量') || ex('曝光'),
                            reads: ex('阅读量') || ex('阅读'), likes: ex('点赞量') || ex('点赞'),
                            favorites: ex('收藏量') || ex('收藏'), comments: ex('评论量') || ex('评论'),
                        };
                    }""")

                    if drawer_data and drawer_data.get("exposure"):
                        note_exposure[nid] = drawer_data["exposure"]
                        for k2, kk in (("reads","readNum"),("likes","likeNum"),
                                       ("favorites","collectNum"),("comments","commentNum")):
                            if drawer_data.get(k2):
                                note_exposure[f"{nid}_{kk}"] = drawer_data[k2]
                        print(f"          [OK] 曝光={drawer_data['exposure']} 阅读={drawer_data.get('reads')} 点赞={drawer_data.get('likes')}")
                    else:
                        print(f"          [WARN] 未提取到曝光数据")

                    # 关闭抽屉
                    try:
                        detail_page.keyboard.press("Escape")
                        time.sleep(0.8)
                    except Exception:
                        pass
                    still_open = detail_page.evaluate(
                        "() => { const d = document.querySelector('.d-drawer-guard'); return d && d.offsetParent != null; }"
                    )
                    if still_open:
                        detail_page.evaluate(
                            "() => { const d = document.querySelector('.d-drawer-guard'); if (d) d.click(); }"
                        )
                        time.sleep(0.5)

        except Exception as e:
            print(f"      [ERROR] 深度采集异常: {e}")

        finally:
            detail_page.remove_listener("response", on_resp_notes)
            try:
                detail_page.close()
            except Exception:
                pass

        return captured

    # ==================== 构建数据行 ====================

    def build_row(self, kol, blogger, captured, top5_cities):
        """构建 CSV 数据行"""
        notes_rate_daily = captured.get("notes_rate_daily_organic") or captured.get("notes_rate_daily_all") or {}
        notes_rate_coop = captured.get("notes_rate_coop_organic") or captured.get("notes_rate_coop_all") or {}

        all_detail_notes = []
        for item in captured.get("notes_detail") or []:
            all_detail_notes.extend(safe_get(item, "data", "list", default=[]) or [])

        female_ratio = safe_get(captured.get("fans_profile", {}), "data", "gender", "female", default=None)
        female_pct = round(female_ratio, 2) if female_ratio is not None else None

        pic_price = blogger.get("picturePrice")
        vid_price = blogger.get("videoPrice")
        pic_price_wan = pic_price / 10000 if pic_price is not None else None
        vid_price_wan = vid_price / 10000 if vid_price is not None else None

        effective_price = None
        if pic_price is not None and self.price_lower <= pic_price <= self.price_upper:
            effective_price = pic_price
        if vid_price is not None and self.price_lower <= vid_price <= self.price_upper:
            if effective_price is None or vid_price < effective_price:
                effective_price = vid_price
        if effective_price is None:
            effective_price = pic_price or vid_price

        note_exposure = captured.get("note_exposure") or {}
        for note in all_detail_notes:
            nid = note.get("noteId")
            if nid and nid in note_exposure:
                note["impNum"] = note_exposure[nid]
                for sfx, key in [("_reads","readNum"), ("_likes","likeNum"),
                                 ("_favorites","collectNum"), ("_comments","commentNum")]:
                    if f"{nid}{sfx}" in note_exposure:
                        note[key] = note_exposure[f"{nid}{sfx}"]

        min_imp_note = self.get_min_imp_coop_note(all_detail_notes)
        min_like_note = self.get_min_like_coop_note(all_detail_notes)

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

        return {
            "达人名称": blogger.get("name") or kol.get("name") or "",
            "内容类目": format_content_tags(blogger.get("contentTags") or kol.get("contentTags")),
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
            "预估CPM": round(cpm, 2) if cpm is not None else None,
            "预估CPE": round(cpe, 2) if cpe is not None else None,
        }

    # ==================== CSV 写入 ====================

    def save_csv(self, results, output_file):
        """写入 CSV（带 BOM + 去重），写入 WORKSPACE_FILES 目录"""
        if not results:
            print("  无结果，跳过写入")
            return

        # 输出到 WORKSPACE_FILES 目录
        if not os.path.isabs(output_file):
            output_file = os.path.join(WORKSPACE_FILES, output_file)

        existing_names = set()
        if os.path.exists(output_file) and os.path.getsize(output_file) > 0:
            try:
                with open(output_file, "r", encoding="utf-8-sig") as f:
                    for line in f:
                        if line.strip():
                            existing_names.add(line.split(",")[0].strip())
            except Exception:
                pass

        new_rows = [r for r in results if r["达人名称"] not in existing_names]
        if not new_rows:
            print(f"  所有 {len(results)} 条均已在文件中存在，跳过")
            return

        write_header = not (os.path.exists(output_file) and os.path.getsize(output_file) > 0)
        with open(output_file, "a", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=HEADERS)
            if write_header:
                writer.writeheader()
            writer.writerows(new_rows)
        print(f"  写入 {len(new_rows)} 条新数据（跳过 {len(results)-len(new_rows)} 条重复）")

    # ==================== 主流程 ====================

    def run(self, output_file):
        """执行完整采集流程"""
        results = []
        debug = {"errors": [], "filtered_in": [], "filtered_out": []}

        cdp_url = f"http://127.0.0.1:{self.cdp_port}"

        with playwright.sync_api.sync_playwright() as p:
            print(f"正在连接 Chrome CDP: {cdp_url}")
            browser = p.chromium.connect_over_cdp(cdp_url)
            context = browser.contexts[0]

            # 找博主广场页面或新建
            main_page = None
            for pg in context.pages:
                url = pg.url
                if "/solar/pre-trade/note/kol" in url:
                    main_page = pg
                    break
            if not main_page:
                for pg in context.pages:
                    if "pgy.xiaohongshu.com" in pg.url and "blogger-detail" not in pg.url:
                        main_page = pg
                        break
            if not main_page:
                for pg in context.pages:
                    if not pg.url.startswith("chrome://"):
                        main_page = pg
                        break
            if not main_page:
                main_page = context.new_page()

            # 导航至博主广场
            if "/solar/pre-trade/note/kol" not in main_page.url:
                print("导航至蒲公英笔记博主广场...")
                main_page.goto(
                    "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
                    wait_until="domcontentloaded", timeout=60000
                )
                time.sleep(3)

            # 登录态检查
            body_text = main_page.inner_text("body")
            if "账号登录" in body_text or "立即登录" in body_text:
                print("\n⚠️ 未检测到登录态！请手动登录后按 Enter 继续...")
                input("按 Enter 继续...")
                main_page.goto(
                    "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
                    wait_until="domcontentloaded", timeout=60000
                )
                time.sleep(3)

            print("✅ 登录态正常")

            # ===== 1. 搜索列表 =====
            print("\n========== 搜索筛选 ==========")
            all_kols = self.fetch_search_kols(main_page)
            print(f"\n搜索接口返回 {len(all_kols)} 个 KOL")

            # ===== 2. 遍历每个 KOL =====
            print("\n========== 逐个评估 ==========")
            prev_detail_page = None
            for idx, kol in enumerate(all_kols, start=1):
                user_id = kol.get("userId")
                name = kol.get("name") or ""
                print(f"\n[{idx}/{len(all_kols)}] {name} {user_id}")

                # 列表页预过滤
                if not self.kol_matches_location(kol):
                    debug["filtered_out"].append({"name": name, "reason": "location"})
                    continue
                if not self.kol_matches_price(kol):
                    debug["filtered_out"].append({"name": name, "reason": "price"})
                    continue
                if not self.kol_matches_fans(kol):
                    debug["filtered_out"].append({"name": name, "reason": "fans"})
                    continue
                if not self.kol_matches_content_tags(kol):
                    debug["filtered_out"].append({"name": name, "reason": "tags"})
                    continue

                print(f"  进入详情页采集（基础信息）...")

                # 第一阶段：只采基础信息（blogger + 粉丝画像 + 日常笔记数值），跳过翻页+抽屉
                captured = None
                for attempt in range(2):
                    try:
                        captured, prev_detail_page = self.fetch_kol_detail(
                            context, user_id, prev_page=prev_detail_page, skip_detail_notes=True
                        )
                        break
                    except Exception as e:
                        print(f"  [ERROR] 第{attempt+1}次: {e}")
                        if attempt == 0:
                            print(f"  清理旧页重试...")
                            if prev_detail_page is not None:
                                try:
                                    prev_detail_page.close()
                                except Exception:
                                    pass
                                prev_detail_page = None
                            time.sleep(2)
                        else:
                            debug["errors"].append({"name": name, "error": str(e)[:200]})
                            captured = None

                if captured is None:
                    continue

                blogger = safe_get(captured, "blogger", "data", default={}) or {}
                if not blogger:
                    debug["errors"].append({"name": name, "stage": "blogger_empty"})
                    continue

                # 详情页二次过滤（轻量检查）
                if not self.kol_matches_location(blogger):
                    debug["filtered_out"].append({"name": name, "reason": "detail_location"})
                    continue
                if not self.kol_matches_price(blogger):
                    debug["filtered_out"].append({"name": name, "reason": "detail_price"})
                    continue
                if not self.kol_matches_fans(blogger):
                    debug["filtered_out"].append({"name": name, "reason": "detail_fans"})
                    continue
                if not self.kol_matches_content_tags(blogger):
                    debug["filtered_out"].append({"name": name, "reason": "detail_tags"})
                    continue

                # 活跃度检查（提前）
                notes_rate_for_active = captured.get("notes_rate_daily_organic") or captured.get("notes_rate_daily_all") or {}
                if not self.is_active_recently(notes_rate_for_active, blogger):
                    print(f"  -> 过滤: 近{self.active_within_days}天未更新")
                    debug["filtered_out"].append({"name": name, "reason": "inactive"})
                    continue

                # 水号检测（提前）
                if self.is_water_account(notes_rate_for_active):
                    print(f"  -> 过滤: 水号")
                    debug["filtered_out"].append({"name": name, "reason": "water_account"})
                    continue

                # 粉丝城市检查（提前）
                fans_profile = captured.get("fans_profile") or {}
                ok_city, top5_cities = self.fan_profile_matches(fans_profile)
                if not ok_city:
                    print(f"  -> 过滤: 粉丝地域不含目标城市")
                    debug["filtered_out"].append({"name": name, "reason": "fan_city"})
                    continue

                # 第二阶段：重操作——翻页 + 抽屉提取合作笔记最低数据
                print(f"  -> 基础检查通过，进入详情页深度采集（翻页+抽屉提取合作笔记曝光）...")
                for attempt in range(2):
                    try:
                        captured_deep = self.extract_coop_notes(
                            context, user_id, prev_page=prev_detail_page
                        )
                        # 合并深度采集的数据
                        if captured_deep.get("notes_detail"):
                            captured["notes_detail"] = captured_deep["notes_detail"]
                        if captured_deep.get("note_exposure"):
                            captured["note_exposure"] = captured_deep["note_exposure"]
                        prev_detail_page = None  # extract_coop_notes 已关闭页面
                        break
                    except Exception as e:
                        print(f"  [ERROR] 深度采集第{attempt+1}次: {e}")
                        if attempt == 0:
                            prev_detail_page = None
                            time.sleep(2)

                # 构建行
                row = self.build_row(kol, blogger, captured, top5_cities)
                results.append(row)
                debug["filtered_in"].append({"name": row["达人名称"], "userId": user_id})
                print(f"  ✅ MATCH: {row['达人名称']} (累计 {len(results)} 条)")

                # 每收集到一个 KOL 就写入 CSV（防中断丢数据）
                print(f"  [写入] 写入 CSV...")
                self.save_csv(results, output_file)

                time.sleep(0.5)

                # 保活
                if idx % 10 == 0:
                    try:
                        main_page.evaluate("1+1")
                    except Exception:
                        break

        # ===== 3. 最终写入 CSV =====
        print("\n========== 写入结果 ==========")
        self.save_csv(results, output_file)

        output_path = os.path.join(WORKSPACE_FILES, output_file)
        print(f"\n✅ 完成！匹配 {len(results)} 个 KOL")
        print(f"   输出文件: {output_path}")
        return results


# ==================== 入口 ====================

def main():
    parser = argparse.ArgumentParser(description="蒲公英 KOL 采集器")
    parser.add_argument("--config", default="kol_config.json", help="配置文件路径")
    parser.add_argument("--output", default=None, help="输出 CSV 文件名（写入 WORKSPACE_FILES 目录）")
    args = parser.parse_args()

    config_path = args.config if os.path.isabs(args.config) else os.path.join(WORKSPACE_FILES, args.config)
    with open(config_path, encoding="utf-8") as f:
        cfg = json.load(f)

    output_file = args.output or cfg.get("output_file", "KOL采集结果.csv")

    # 所有产出写入 WORKSPACE_FILES
    output_path = os.path.join(WORKSPACE_FILES, output_file)
    os.makedirs(WORKSPACE_FILES, exist_ok=True)

    collector = PgyCollector(cfg)
    collector.run(output_file)


if __name__ == "__main__":
    main()
