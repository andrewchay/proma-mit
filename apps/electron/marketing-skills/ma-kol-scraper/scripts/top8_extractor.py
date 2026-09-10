"""对 CSV 中每个达人采集「笔记案例 → 合作笔记」第一页前 8 条笔记的曝光数与点赞数。
数据来自逐个点开笔记详情抽屉（抽屉内有「曝光量/阅读量/点赞量」指标面板）。
输出 top8_notes.json，增量续采（按 userId 去重）。
用法: python3 top8_extractor.py --csv xxx.csv [--out top8_notes.json] [--port 9222]
"""
import argparse, csv, json, os, re, sys, time
from playwright.sync_api import sync_playwright

DRAWER_EXTRACT_JS = """() => {
    // 直接扫描「note-data_item / item-content」指标行（如「曝光量 66,695」），
    // 注意不要用背景概览卡片（note-data-wrapper 含「曝光中位数」）当数据源。
    // title：取抽屉内容第一行文本（笔记标题）。
    const res = { title: null, text: null, imp: null, read: null, like: null, collect: null, comment: null };
    let drawerEl = document.querySelector('.d-drawer-content, [class*=drawer-content], [class*=drawerContent]');
    if (drawerEl) {
        const lines = (drawerEl.innerText || '').split('\\n').map(l => l.trim()).filter(l => l);
        if (lines.length) res.title = lines[0].slice(0, 200);
        // 正文片段：标题之后的连续文本，遇指标/时间/评论标记停止，最多400字
        const stopKeys = ['曝光量','阅读量','点赞量','收藏量','评论量','分享量','发布于','精选评论','全部评论','关注'];
        const textLines = [];
        for (let i = 1; i < lines.length && textLines.join('').length < 400; i++) {
            if (stopKeys.some(k => lines[i].startsWith(k))) break;
            textLines.push(lines[i]);
        }
        res.text = textLines.join(' ').slice(0, 400);
    }
    const parseNum = (raw, unit) => {
        const n = parseFloat((raw || '').replace(/,/g, ''));
        if (isNaN(n)) return null;
        if (unit === '万' || unit === 'w') return Math.round(n * 10000);
        if (unit === '千' || unit === 'k') return Math.round(n * 1000);
        return Math.round(n);
    };
    const rows = document.querySelectorAll('.note-data_item, [class*=note-data_item], [class*=item-content]');
    for (const el of rows) {
        const t = el.textContent.trim();
        const m = t.match(/^(曝光量|阅读量|点赞量|收藏量|评论量)\\s+([\\d,.]+)\\s*(万|千|w|k)?\\s*$/);
        if (!m) continue;
        const v = parseNum(m[2], m[3]);
        if (v === null) continue;
        if (m[1] === '曝光量') res.imp = v;
        else if (m[1] === '阅读量') res.read = v;
        else if (m[1] === '点赞量') res.like = v;
        else if (m[1] === '收藏量') res.collect = v;
        else if (m[1] === '评论量') res.comment = v;
    }
    return res;
}"""

COMMENT_EXTRACT_JS = """() => {
    // 抽屉内评论列表（昵称+文本）。PGY DOM：评论项 .pgy-comment-item，
    // 昵称 .comment-username，文本 .comment-content。
    const pick = (el) => {
        if (!el) return null;
        const t = el.textContent.trim();
        return t ? t.slice(0, 300) : null;
    };
    let c = document.querySelector('.d-drawer-content, [class*=drawer-content], [class*=drawerContent]');
    if (!c) return [];
    const blocks = c.querySelectorAll('.pgy-comment-item, [class*=pgy-comment-item], [class*=comment-item], [class*=commentItem]');
    const out = [];
    if (blocks.length) {
        blocks.forEach(b => {
            const nick = pick(b.querySelector('.comment-username, [class*=comment-username], [class*=comment-name]'));
            const txt = pick(b.querySelector('.comment-content, [class*=comment-content]'));
            if (txt || nick) out.push({user: nick || '', text: txt || ''});
        });
    } else {
        const lines = (c.innerText || '').split('\\n').map(l => l.trim()).filter(l => l);
        for (let i = 0; i < lines.length && out.length < 20; i++) {
            if (lines[i] && lines[i].length > 2 && !['曝光量', '阅读量', '点赞量', '收藏量', '评论量', '分享量', '关注量', '全部评论', '评论', '精选评论', '作者'].includes(lines[i])) {
                out.push({user: lines[i], text: lines[i + 1] || ''});
                i++;
            }
        }
    }
    return out.slice(0, 20);
}"""

CLICK_CARD_JS = """({idx}) => {
    const cards = document.querySelectorAll('.note-card-wrapper');
    if (idx >= cards.length) return false;
    const card = cards[idx];
    const mask = card.querySelector('.note-card__mask, [class*=mask]');
    if (mask) { mask.scrollIntoView({block: 'center'}); mask.click(); return true; }
    card.scrollIntoView({block: 'center'});
    card.click();
    return true;
}"""

def navigate_to_note_cases(page, user_id):
    url = f"https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/{user_id}"
    page.goto(url, wait_until="domcontentloaded", timeout=30000)
    time.sleep(3.5)
    try:
        page.evaluate("() => { const el=document.querySelector('.d-modal-close'); if(el) el.click(); }")
        time.sleep(0.8)
    except Exception:
        pass
    try:
        page.evaluate("""() => {
            const tabs = document.querySelectorAll('.d-tabs-header-label, [class*=tab]');
            const t = Array.from(tabs).find(el => el.textContent.trim() === '数据概览');
            if (t) t.click();
        }""")
        time.sleep(1.8)
    except Exception:
        pass
    try:
        page.evaluate("window.scrollTo(0, 1700)")
        time.sleep(0.8)
    except Exception:
        pass
    # 笔记案例 tab
    try:
        page.evaluate("""() => {
            const tabs = document.querySelectorAll('.d-tabs-header-label, [class*=tab]');
            const t = Array.from(tabs).find(el => el.textContent.trim() === '笔记案例');
            if (t) { t.click(); return true; }
            return false;
        }""")
        time.sleep(2.5)
    except Exception:
        pass
    # 按笔记类型 → 合作笔记（默认已选中，这里确保）
    try:
        page.evaluate("""() => {
            const segs = document.querySelectorAll('.d-segment-item, [class*=segment]');
            const allCoop = Array.from(segs).filter(el => el.textContent.trim() === '合作笔记');
            const coop = allCoop.length >= 2 ? allCoop[1] : (allCoop[0] || null);
            if (coop) { coop.click(); return true; }
            return false;
        }""")
        time.sleep(1.8)
    except Exception:
        pass


def extract_top8(page):
    """按 DOM 卡片顺序提取第一页前 8 张合作笔记的 曝光/点赞。返回 (list_of_note_metrics, count)。"""
    dom_count = page.evaluate("() => document.querySelectorAll('.note-card-wrapper').length")
    if dom_count <= 0:
        return [], 0
    n = min(8, dom_count)
    results = []
    for ci in range(n):
        if ci > 0:
            try:
                page.keyboard.press("Escape")
                time.sleep(0.7)
            except Exception:
                pass
            # 确保上个抽屉关闭
            try:
                page.evaluate("""() => {
                    const g = document.querySelector('.d-drawer-guard');
                    if (g && g.offsetParent != null) g.click();
                }""")
                time.sleep(0.4)
            except Exception:
                pass
        clicked = page.evaluate(CLICK_CARD_JS, {"idx": ci})
        if not clicked:
            results.append(None)
            continue
        time.sleep(2.2)
        metrics = page.evaluate(DRAWER_EXTRACT_JS)
        # 顺带抓抽屉评论（同一抽屉内，抽屉已开启约2s，评论应已渲染）
        comments = []
        try:
            comments = page.evaluate(COMMENT_EXTRACT_JS) or []
        except Exception:
            comments = []
        if metrics:
            metrics["comments"] = comments
        results.append(metrics)
    return results, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", default="top8_notes.json")
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--limit", type=int, default=0, help="本次最多处理 N 个达人，0=不限（批量重启防连接崩溃）")
    args = ap.parse_args()

    # 读取 CSV 达人（userId / 名称）
    kols = []
    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            uid = (row.get("userId") or "").strip()
            if uid:
                kols.append({"userId": uid, "name": (row.get("达人名称") or "").strip()})

    # 断点
    out_path = os.path.abspath(args.out)
    done = {}
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as f:
                done = json.load(f)
        except Exception:
            done = {}

    pending = [k for k in kols if k["userId"] not in done]
    if args.limit and args.limit > 0:
        pending = pending[: args.limit]
    print(f"CSV 达人 {len(kols)} 个，已完成 {len(done)} 个，本批待采集 {len(pending)} 个")
    if not pending:
        print("全部完成")
        return

    with sync_playwright() as p:
        browser = None
        ctx = None

        def connect():
            """(重)连接 CDP 并获取 context。连接失效时全量重建。
            注意：connect_over_cdp 的 browser.close() 会关闭 Chrome 进程，
            因此重连时只重新 connect，不 close 旧 browser 对象。"""
            nonlocal browser, ctx
            time.sleep(1)
            browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{args.port}")
            ctx = browser.contexts[0] if browser.contexts else browser.new_context()
            return ctx

        ctx = connect()
        # 清理历史遗留页面，避免 Chrome 页面累积导致连接崩溃
        try:
            for pg in list(ctx.pages):
                try:
                    pg.close()
                except Exception:
                    pass
        except Exception:
            pass
        CONN_DEAD = "has been closed"
        for i, kol in enumerate(pending):
            uid, name = kol["userId"], kol["name"]
            ok = False
            last_err = ""
            conn_dead = False
            # 每达人新建页面、用完即关；连接失效时重连 CDP 再重试；
            # 若重连也失败（CDP 会话整体死亡）→ 立即退出，外层循环重启进程续采。
            for attempt in range(3):
                page = None
                try:
                    if ctx is None:
                        ctx = connect()
                    page = ctx.new_page()
                    navigate_to_note_cases(page, uid)
                    metrics, n = extract_top8(page)
                    imp_vals, like_vals, read_vals, comments, titles, texts = [], [], [], [], [], []
                    for m in metrics:
                        if m and m.get("imp"):
                            imp_vals.append(m["imp"])
                        if m and m.get("like"):
                            like_vals.append(m["like"])
                        if m and m.get("read"):
                            read_vals.append(m["read"])
                        if m and m.get("comments"):
                            comments.extend(m["comments"])
                        if m and m.get("title"):
                            titles.append(m["title"])
                        if m and m.get("text"):
                            texts.append(m["text"])
                    done[uid] = {
                        "name": name,
                        "n": n,
                        "imp": imp_vals,
                        "like": like_vals,
                        "read": read_vals,
                        "titles": titles,
                        "texts": texts,
                        "comments": comments,
                    }
                    ok = True
                    print(f"[{i+1}/{len(pending)}] {name} ({uid}) OK: imp={imp_vals} like={like_vals} comments={len(comments)}")
                    break
                except Exception as e:
                    last_err = str(e)[:200]
                    print(f"[{i+1}/{len(pending)}] {name} ({uid}) attempt{attempt+1} FAIL: {last_err}")
                    try:
                        ctx = connect()
                    except Exception as e2:
                        last_err = f"{last_err} | recon: {str(e2)[:80]}"
                        if CONN_DEAD in str(e2):
                            conn_dead = True
                        time.sleep(3)
                    time.sleep(2)
                finally:
                    if page is not None:
                        try:
                            page.close()
                        except Exception:
                            pass
            # 写盘（含本次结果）
            tmp = out_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(done, f, ensure_ascii=False, indent=1)
            os.replace(tmp, out_path)
            if not ok:
                print(f"[{i+1}/{len(pending)}] {name} ({uid}) FINAL FAIL: {last_err}")
            # CDP 会话整体死亡 → 立即退出，让外层循环重启（避免无效失败遍历）
            if conn_dead:
                print("=== CDP 会话死亡，退出等待外层重启（已完成 %d/%d）===" % (len(done), len(kols)))
                sys.exit(42)
            time.sleep(1)
    print(f"完成。结果写入 {out_path}，共 {len(done)} 个达人")


if __name__ == "__main__":
    main()
