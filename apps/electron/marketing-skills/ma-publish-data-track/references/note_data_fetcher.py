#!/usr/bin/env python3
"""
蒲公英笔记数据抓取脚本（参考模板）
对应 ma-publish-data-track skill 的「发布后查数」能力。

复用 ma-kol-scraper 的 CDP 方法论（kol_collector.py）：
- _init_browser：connect_over_cdp + 登录态检查 + 页面复用
- on("response") 捕获 API 数据
- 连接中断自动重连

与 kol_collector.py 的区别：kol_collector 按 userId 批量采博主全部合作笔记；
本脚本按 noteId 打开蒲公英笔记数据页，抓取单条笔记的曝光/阅读/点赞/收藏/评论。

用法：
    python note_data_fetcher.py <note_link|note_id> [--output <json路径>]
    示例：python note_data_fetcher.py "https://www.xiaohongshu.com/explore/xxxx" --output note_stats.json
"""
import argparse
import json
import os
import re
import sys
import time

import playwright.sync_api

CDP_URL = "http://127.0.0.1:9222"
# 蒲公英笔记数据页 URL 模式（按 noteId 打开）
NOTE_DETAIL_URL = "https://pgy.xiaohongshu.com/solar/pre-trade/note/detail?noteId={note_id}"

# 笔记 id 提取：支持 xhslink 短链 / 完整 explore 链接 / 纯 noteId
XHS_LINK_RE = re.compile(r"xhslink\.cn\S*")
NOTE_ID_RE = re.compile(r"/explore/([0-9a-zA-Z]+)|/discovery/item/([0-9a-zA-Z]+)|noteId=([0-9a-zA-Z]+)")

# 笔记数据相关 API 片段（on_response 捕获用）
_NOTE_API_MARKERS = (
    "/api/solar/cooperator/note/detail",
    "/api/solar/cooperator/note/data",
    "/api/solar/cooperator/blogger/note",
    "/note/detail",
    "/note/data",
)


def _is_conn_lost(e: Exception) -> bool:
    """判断异常是否属于浏览器/连接/网络中断（可自动重连恢复）"""
    msg = str(e)
    closed_markers = ("has been closed", "Target closed", "Connection closed",
                      "browser has been closed", "context has been closed",
                      "Target page, context or browser has been closed",
                      "net::ERR_INTERNET_DISCONNECTED", "net::ERR_NETWORK_CHANGED",
                      "net::ERR_CONNECTION", "net::ERR_NAME_NOT_RESOLVED",
                      "net::ERR_ADDRESS_UNREACHABLE", "net::ERR_TIMED_OUT",
                      "ERR_INTERNET_DISCONNECTED", "ERR_NETWORK_CHANGED")
    return any(m in msg for m in closed_markers)


def resolve_note_id(input_str: str) -> str:
    """从输入解析 noteId：支持 xhslink 短链（需页面跳转解析）/ 完整链接 / 纯 ID"""
    s = (input_str or "").strip()
    if not s:
        return ""
    m = NOTE_ID_RE.search(s)
    if m:
        return next((g for g in m.groups() if g), "")
    # 纯 noteId（字母数字，20 位左右）
    if re.fullmatch(r"[0-9a-zA-Z]{10,32}", s):
        return s
    return ""


def _init_browser(p, cdp_url: str):
    """连接 CDP、复用页面并检查登录态（移植自 kol_collector._init_browser）"""
    print(f"正在连接 Chrome CDP: {cdp_url}")
    try:
        browser = p.chromium.connect_over_cdp(cdp_url)
    except Exception as e:
        raise RuntimeError(f"无法连接 Chrome CDP: {e}")
    context = browser.contexts[0]

    main_page = None
    for pg in context.pages:
        url = pg.url
        if "pgy.xiaohongshu.com" in url and "blogger-detail" not in url:
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


def fetch_note_stats(p, note_id: str, timeout: int = 20) -> dict:
    """打开蒲公英笔记数据页，捕获笔记数据 API 并解析曝光/阅读/点赞/收藏/评论"""
    browser, context, page = _init_browser(p, CDP_URL)
    captured: dict = {}

    def on_resp(resp):
        url = resp.url
        if not any(m in url for m in _NOTE_API_MARKERS):
            return
        try:
            if "application/json" in (resp.headers.get("content-type") or ""):
                data = resp.json()
                captured["json"] = data
            else:
                captured["text"] = resp.text()
        except Exception:
            pass

    page.on("response", on_resp)
    url = NOTE_DETAIL_URL.format(note_id=note_id)
    print(f"打开笔记数据页: {url}")
    page.goto(url, wait_until="domcontentloaded", timeout=30000)
    time.sleep(2)

    start = time.time()
    while time.time() - start < timeout and not captured:
        time.sleep(1)

    page.remove_listener("response", on_resp)
    browser.close()  # CDP 连接：只断开不关浏览器（browser.close 对 CDP 连接是断开）

    if not captured:
        return {"note_id": note_id, "error": "未捕获到笔记数据 API（可能页面结构变化或未登录）"}

    stats = _extract_stats(captured)
    stats["note_id"] = note_id
    return stats


def _extract_stats(captured: dict) -> dict:
    """从捕获的 API 数据里提取指标。兼容多种返回结构（data/result/records/list）。"""
    raw = captured.get("json") or captured.get("text") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return {"error": "API 返回非 JSON"}

    # 深入 data / result / list 找指标对象
    node = raw
    for key in ("data", "result", "records", "list"):
        if isinstance(node, dict) and node.get(key):
            node = node[key]
            break
    if isinstance(node, list) and node:
        node = node[0]
    if not isinstance(node, dict):
        return {"error": "无法解析笔记数据"}

    def _num(*keys):
        for k in keys:
            v = node.get(k)
            if v is not None:
                try:
                    return int(v)
                except (TypeError, ValueError):
                    pass
        return None

    stats = {
        "exposure": _num("exposure", "exposeNum", "expose_num", "pv"),
        "reads": _num("reads", "readNum", "read_num"),
        "likes": _num("likes", "likeNum", "like_num", "likeCount", "like_count"),
        "comments": _num("comments", "commentNum", "comment_num", "commentCount", "comment_count"),
        "favorites": _num("favorites", "favoriteNum", "favorite_num", "collectNum", "collect_num"),
    }
    if all(v is None for v in stats.values()):
        # 兜底：从原始 JSON 里模糊搜数字字段
        keys_found = [k for k in node.keys() if any(
            kw in k.lower() for kw in ("expo", "read", "like", "comment", "favorite", "collect", "play")
        )]
        return {"error": "未识别到指标字段", "raw_keys": keys_found[:20], "raw_sample": str(node)[:500]}
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="蒲公英笔记数据抓取（复用 ma-kol-scraper CDP 方法论）")
    parser.add_argument("input", help="笔记链接（xhslink/完整链接）或 noteId")
    parser.add_argument("--output", default="", help="输出 JSON 路径（缺省打印 stdout）")
    args = parser.parse_args()

    note_id = resolve_note_id(args.input)
    if not note_id:
        print(f"无法从输入解析 noteId: {args.input}")
        sys.exit(1)

    try:
        with playwright.sync_api.sync_playwright() as p:
            stats = fetch_note_stats(p, note_id)
    except RuntimeError as e:
        print(f"❌ {e}")
        sys.exit(2)
    except Exception as e:
        if _is_conn_lost(e):
            print(f"⚠️ 连接中断，重试一次...")
            time.sleep(2)
            try:
                with playwright.sync_api.sync_playwright() as p:
                    stats = fetch_note_stats(p, note_id)
            except Exception as e2:
                print(f"❌ 重试仍失败: {e2}")
                sys.exit(3)
        else:
            print(f"❌ 抓取失败: {e}")
            sys.exit(4)

    if args.output:
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
        print(f"✅ 已写入: {args.output}")
    else:
        print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
