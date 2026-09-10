#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小红书站内 KOL 笔记 + 评论采集器（移植自 MediaCrawler 核心逻辑，由 ma-kol-scraper skill 驱动）

用途：互暖排查的数据采集阶段。对候选人名单里的站内 user_id，抓取其近期笔记与评论，
产出与 MediaCrawler 完全一致的 JSONL schema：
  - <output_dir>/creator_contents_YYYY-MM-DD.jsonl（笔记，含 creator_hash 脱敏）
  - <output_dir>/creator_comments_YYYY-MM-DD.jsonl（评论，含明文 user_id + ip_location）

原理：
  - 复用用户真实 Chrome（CDP）获取小红书站内登录态 Cookie（无需重新登录）
  - 用 xhshow 纯算法库生成 x-s/x-t 签名，httpx 发起站内 API 请求（与 MediaCrawler 一致）
  - 签名、解析逻辑来自 MediaCrawler，已剥离 config/DB/代理/媒体下载等耦合

依赖（pip）：
  playwright>=1.61.0, httpx, tenacity, pyhumps, xhshow>=0.2.0

用法：
  python3 collect_creator_xhs.py \
      --cdp-port 9222 \
      --user-id <user_id1> --user-id <user_id2> \
      --max-notes 10 --max-comments 25 \
      --output-dir <数据目录>
  可选 --skip-comments 只采笔记不采评论（用于第二层嫌疑号主页画像）。
"""
import argparse
import asyncio
import hashlib
import json
import os
import re
import time
from typing import Any, Callable, Dict, List, Optional

import httpx
from playwright.async_api import async_playwright

# ---------- 签名相关（来自 MediaCrawler media_platform/xhs） ----------
try:
    from xhshow import Xhshow
except ImportError as e:  # pragma: no cover
    raise SystemExit(
        "缺少依赖 xhshow。请先安装: pip install xhshow>=0.2.0 （README: https://github.com/Cloxl/xhshow）"
    ) from e


def _get_trace_id() -> str:
    import random
    return "".join(random.choice("abcdef0123456789") for _ in range(16))


def _sign_with_xhshow(uri: str, data: Optional[Dict] = None, cookie_str: str = "",
                      method: str = "POST") -> Dict[str, Any]:
    """使用 xhshow 纯算法生成完整签名请求头（GET/POST）"""
    client = Xhshow()
    if method.upper() == "POST":
        headers = client.sign_headers_post(
            uri=uri, cookies=cookie_str, payload=data if isinstance(data, dict) else {})
    else:
        headers = client.sign_headers_get(
            uri=uri, cookies=cookie_str, params=data if isinstance(data, dict) else {})
    return {
        "x-s": headers.get("x-s", ""),
        "x-t": headers.get("x-t", ""),
        "x-s-common": headers.get("x-s-common", ""),
        "x-b3-traceid": headers.get("x-b3-traceid", _get_trace_id()),
    }


# ---------- 匿名化 / 脱敏（来自 MediaCrawler tools/user_hash.py） ----------
def anonymize_user_id(user_id) -> str:
    if user_id is None:
        return ""
    s = str(user_id).strip()
    if not s:
        return ""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def mask_nickname(name) -> str:
    if name is None:
        return ""
    s = str(name)
    if len(s) <= 1:
        return "*"
    if len(s) == 2:
        return s[0] + "*"
    return s[0] + "***" + s[-1]


# ---------- HTML 抽取（来自 MediaCrawler media_platform/xhs/extractor.py） ----------
def extract_creator_info_from_html(html: str) -> Optional[Dict]:
    """从用户主页 HTML 的 window.__INITIAL_STATE__ 解析用户数据（用户画像第二层）"""
    match = re.search(r"<script>window.__INITIAL_STATE__=(.+)<\/script>", html, re.M)
    if match is None:
        return None
    info = json.loads(match.group(1).replace(":undefined", ":null"), strict=False)
    if info is None:
        return None
    return info.get("user", {}).get("userPageData")


# ---------- store 落盘（schema 与 MediaCrawler 一致） ----------
async def write_jsonl(path: str, record: dict) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def current_date() -> str:
    return time.strftime("%Y-%m-%d")


async def save_note(note_item: Dict, output_dir: str) -> None:
    note_id = note_item.get("note_id")
    user_info = note_item.get("user", {})
    interact_info = note_item.get("interact_info", {})
    image_list = note_item.get("image_list", []) or []
    tag_list = note_item.get("tag_list", []) or []

    local_db_item = {
        "note_id": note_id,
        "type": note_item.get("type"),
        "title": note_item.get("title") or note_item.get("desc", "")[:255],
        "desc": note_item.get("desc", ""),
        "time": note_item.get("time"),
        "last_update_time": note_item.get("last_update_time", 0),
        "creator_hash": anonymize_user_id(user_info.get("user_id")),
        "nickname": mask_nickname(user_info.get("nickname")),
        "liked_count": interact_info.get("liked_count"),
        "collected_count": interact_info.get("collected_count"),
        "comment_count": interact_info.get("comment_count"),
        "share_count": interact_info.get("share_count"),
        "note_url": f"https://www.xiaohongshu.com/explore/{note_id}?xsec_token={note_item.get('xsec_token')}&xsec_source=pc_search",
        "source_keyword": "",
        "xsec_token": note_item.get("xsec_token"),
        "user_id": user_info.get("user_id", ""),  # 额外补充：明文用户 id，便于关联名单
    }
    await write_jsonl(
        os.path.join(output_dir, f"creator_contents_{current_date()}.jsonl"), local_db_item)


async def save_comment(note_id: str, comment_item: Dict, output_dir: str) -> None:
    user_info = comment_item.get("user_info", {})
    comment_id = comment_item.get("id")
    target_comment = comment_item.get("target_comment", {})
    local_db_item = {
        "comment_id": comment_id,
        "create_time": comment_item.get("create_time"),
        "note_id": note_id,
        "content": comment_item.get("content"),
        "creator_hash": anonymize_user_id(user_info.get("user_id")),
        "user_id": user_info.get("user_id", ""),
        "ip_location": comment_item.get("ip_location") or comment_item.get("ip_region", ""),
        "nickname": mask_nickname(user_info.get("nickname")),
        "sub_comment_count": comment_item.get("sub_comment_count", 0),
        "parent_comment_id": target_comment.get("id", ""),
        "like_count": comment_item.get("like_count", 0),
    }
    await write_jsonl(
        os.path.join(output_dir, f"creator_comments_{current_date()}.jsonl"), local_db_item)


# ---------- XHS API 客户端（移植自 MediaCrawler，剥离代理/DB/扩展） ----------
class _XhsError(Exception):
    pass


class _XhsBlocked(_XhsError):
    pass


class XiaoHongShuClient:
    def __init__(self, cookie_str: str, timeout: float = 30.0):
        self._host = "https://edith.xiaohongshu.com"
        self._domain = "https://www.xiaohongshu.com"
        self.timeout = timeout
        self.headers = {
            "accept": "application/json, text/plain, */*",
            "accept-language": "zh-CN,zh;q=0.9",
            "cache-control": "no-cache",
            "content-type": "application/json;charset=UTF-8",
            "origin": self._domain,
            "pragma": "no-cache",
            "referer": f"{self._domain}/",
            "sec-ch-ua": '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"macOS"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
            "Cookie": cookie_str,
        }

    @staticmethod
    def _build_query_string(params: Dict) -> str:
        from urllib.parse import quote
        parts = []
        for key, value in params.items():
            value_str = str(value) if value is not None else ""
            parts.append(f"{key}={quote(value_str, safe=',')}")
        return "&".join(parts)

    async def _pre_headers(self, uri: str, params: Optional[Dict] = None,
                           payload: Optional[Dict] = None) -> Dict:
        if params is not None:
            data, method = params, "GET"
        elif payload is not None:
            data, method = payload, "POST"
        else:
            raise _XhsError("params or payload is required")
        signs = _sign_with_xhshow(uri, data=data, cookie_str=self.headers.get("Cookie", ""),
                                  method=method)
        self.headers.update({
            "X-S": signs["x-s"], "X-T": signs["x-t"],
            "x-S-Common": signs["x-s-common"], "X-B3-Traceid": signs["x-b3-traceid"],
        })
        return self.headers

    def _decode(self, response: httpx.Response) -> Dict:
        if response.status_code in {401, 403, 429}:
            raise _XhsBlocked(f"XHS request blocked with HTTP {response.status_code}")
        data = response.json()
        if not data.get("success"):
            code = data.get("code")
            if code in (-510000, -510001):
                raise _XhsError(f"Note not found or abnormal, code: {code}")
            if code in (300012,):
                raise _XhsBlocked("IP block error")
            if code in (300011,):
                raise _XhsBlocked("Account security restriction")
            raise _XhsError(data.get("msg") or str(response.text))
        return data.get("data", {})

    async def get(self, uri: str, params: Optional[Dict] = None) -> Dict:
        headers = await self._pre_headers(uri, params)
        url = f"{self._host}{uri}?{self._build_query_string(params)}" if params else f"{self._host}{uri}"
        async with httpx.AsyncClient(verify=True) as client:
            resp = await client.get(url, headers=headers, timeout=self.timeout)
        return self._decode(resp)

    async def post(self, uri: str, data: dict) -> Dict:
        headers = await self._pre_headers(uri, payload=data)
        body = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        async with httpx.AsyncClient(verify=True) as client:
            resp = await client.post(f"{self._host}{uri}", data=body, headers=headers,
                                     timeout=self.timeout)
        return self._decode(resp)

    async def pong(self) -> bool:
        """校验登录态是否有效"""
        try:
            data = await self.get("/api/sns/web/v1/user/selfinfo", params={})
            return bool(data.get("result", {}).get("success"))
        except Exception:
            return False

    async def get_notes_by_creator(self, creator: str, cursor: str, page_size: int = 30,
                                   xsec_token: str = "", xsec_source: str = "pc_feed") -> Dict:
        params = {
            "num": page_size, "cursor": cursor, "user_id": creator,
            "image_formats": "jpg,webp,avif",
            "xsec_token": xsec_token, "xsec_source": xsec_source,
        }
        return await self.get("/api/sns/web/v1/user_posted", params)

    async def get_note_by_id(self, note_id: str, xsec_source: str, xsec_token: str) -> Dict:
        if not xsec_source:
            xsec_source = "pc_search"
        data = {
            "source_note_id": note_id,
            "image_formats": ["jpg", "webp", "avif"],
            "extra": {"need_body_topic": 1},
            "xsec_source": xsec_source, "xsec_token": xsec_token,
        }
        res = await self.post("/api/sns/web/v1/feed", data)
        if res and res.get("items"):
            return res["items"][0]["note_card"]
        return {}

    async def get_note_comments(self, note_id: str, xsec_token: str, cursor: str = "") -> Dict:
        params = {
            "note_id": note_id, "cursor": cursor, "top_comment_id": "",
            "image_formats": "jpg,webp,avif", "xsec_token": xsec_token,
        }
        return await self.get("/api/sns/web/v2/comment/page", params)

    async def get_note_all_comments(self, note_id: str, xsec_token: str, crawl_interval: float = 1.0,
                                    callback: Optional[Callable] = None, max_count: int = 50) -> List[Dict]:
        result = []
        has_more, cursor = True, ""
        while has_more and len(result) < max_count:
            res = await self.get_note_comments(note_id, xsec_token, cursor)
            has_more = res.get("has_more", False)
            cursor = res.get("cursor", "")
            comments = res.get("comments") or []
            if len(result) + len(comments) > max_count:
                comments = comments[: max_count - len(result)]
            if callback:
                await callback(note_id, comments)
            result.extend(comments)
            await asyncio.sleep(crawl_interval)
        return result

    async def get_creator_profile_html(self, user_id: str, xsec_token: str = "",
                                       xsec_source: str = "") -> str:
        """抓取用户主页 HTML（第二层画像：判断嫌疑号是否也是 KOC）"""
        uri = f"/user/profile/{user_id}"
        if xsec_token and xsec_source:
            uri = f"{uri}?xsec_token={xsec_token}&xsec_source={xsec_source}"
        async with httpx.AsyncClient(verify=True) as client:
            resp = await client.get(self._domain + uri, headers=self.headers, timeout=self.timeout)
        if resp.status_code in {401, 403, 429}:
            raise _XhsBlocked(f"profile blocked HTTP {resp.status_code}")
        return resp.text


async def crawl_creator(client: XiaoHongShuClient, user_id: str, output_dir: str,
                        max_notes: int = 10, max_comments: int = 25,
                        get_comments: bool = True, crawl_interval: float = 1.0) -> None:
    """抓取单个达人的笔记 + 评论"""
    print(f"\n[{user_id}] 开始采集（最多 {max_notes} 篇笔记）")
    # 笔记列表
    result = []
    has_more, cursor = True, ""
    while has_more and len(result) < max_notes:
        try:
            res = await client.get_notes_by_creator(user_id, cursor)
        except _XhsBlocked as e:
            print(f"[{user_id}] 风控拦截: {e}，跳过该达人")
            return
        if not res:
            print(f"[{user_id}] 无法获取笔记（可能被限或非达人），跳过")
            return
        has_more = res.get("has_more", False)
        cursor = res.get("cursor", "")
        notes = res.get("notes") or []
        to_add = notes[: max_notes - len(result)]
        result.extend(to_add)
        await asyncio.sleep(crawl_interval)

    print(f"[{user_id}] 列表获取 {len(result)} 篇")

    # 笔记详情 + 评论
    async def _save_comments(nid: str, comments: List[Dict]) -> None:
        for c in comments:
            await save_comment(nid, c, output_dir)

    for idx, summary in enumerate(result, 1):
        note_id = summary.get("note_id")
        if not note_id:
            continue
        xsec_token = summary.get("xsec_token", "")
        xsec_source = summary.get("xsec_source", "pc_feed")
        print(f"[{user_id}]  笔记 {idx}/{len(result)}: {note_id}")
        # 详情（含完整 user 信息）
        try:
            detail = await client.get_note_by_id(note_id, xsec_source, xsec_token)
        except _XhsError as e:
            print(f"[{user_id}]    笔记详情失败: {e}")
            detail = {}
        if not detail:
            # 降级：用列表中的字段
            detail = dict(summary)
        detail.setdefault("xsec_token", xsec_token)
        detail.setdefault("xsec_source", xsec_source)
        await save_note(detail, output_dir)
        if get_comments:
            try:
                await client.get_note_all_comments(
                    note_id, xsec_token, crawl_interval=crawl_interval,
                    callback=_save_comments, max_count=max_comments)
            except _XhsError as e:
                print(f"[{user_id}]    评论采集失败: {e}")
        await asyncio.sleep(crawl_interval)


async def ensure_cdp_login(cdp_port: int) -> str:
    """连接 CDP，取小红书站内 Cookie；无登录态则抛异常"""
    cdp_url = f"http://127.0.0.1:{cdp_port}"
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0]
        # 找到一个非空的页面，确保能取到 cookie
        if not context.pages:
            page = await context.new_page()
            await page.goto("https://www.xiaohongshu.com", wait_until="domcontentloaded")
        else:
            page = context.pages[0]
        cookies = await context.cookies(["https://www.xiaohongshu.com", "https://edith.xiaohongshu.com"])
        cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
        return cookie_str


async def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="小红书站内 KOL 笔记+评论采集")
    parser.add_argument("--cdp-port", type=int, default=9222, help="Chrome CDP 端口")
    parser.add_argument("--user-id", action="append", required=True,
                        help="站内 user_id，可多次指定")
    parser.add_argument("--max-notes", type=int, default=10, help="单达人最大笔记数")
    parser.add_argument("--max-comments", type=int, default=25, help="单笔记最大一级评论数")
    parser.add_argument("--skip-comments", action="store_true", help="只采笔记不采评论(第二层画像)")
    parser.add_argument("--output-dir", required=True, help="JSONL 输出目录")
    parser.add_argument("--interval", type=float, default=1.0, help="抓取间隔(秒)")
    args = parser.parse_args(argv)

    os.makedirs(args.output_dir, exist_ok=True)

    print("请确保 Chrome 已打开远程调试端口并已登录小红书(www.xiaohongshu.com)")
    print(f"连接 CDP: http://127.0.0.1:{args.cdp_port}")
    try:
        cookie_str = await ensure_cdp_login(args.cdp_port)
    except Exception as e:
        print(f"[FAIL] 无法连接 Chrome CDP: {e}")
        print("请先启动带远程调试端口的 Chrome：")
        print("  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\")
        print(f"    --remote-debugging-port={args.cdp_port} --user-data-dir=/tmp/chrome_xhs_debug")
        return 1

    client = XiaoHongShuClient(cookie_str)
    if not await client.pong():
        print("[FAIL] 小红书登录态无效，请先在连接的 Chrome 中登录 www.xiaohongshu.com")
        return 1
    print("[OK] 登录态正常")

    get_comments = not args.skip_comments
    for uid in args.user_id:
        uid = uid.strip()
        if not uid:
            continue
        await crawl_creator(client, uid, args.output_dir,
                            max_notes=args.max_notes, max_comments=args.max_comments,
                            get_comments=get_comments, crawl_interval=args.interval)
    print("\n采集完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))