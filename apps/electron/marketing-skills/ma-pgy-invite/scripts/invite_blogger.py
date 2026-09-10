#!/usr/bin/env python3
"""蒲公英博主笔记合作邀约一键脚本（通用参数化版）。

通过 CDP 连接已登录蒲公英的 Chrome，向指定博主发起笔记合作邀约并提交。

用法示例（确保 Chrome 已开 9222 远程调试端口并登录蒲公英）：
  python3 invite_blogger.py "K姐姐i" \
      --wechat dennis1zhangzhang \
      --product 忘本甄果 \
      --desc 详解详聊 \
      --start 2026-08-31 --end 2026-09-15

参数：
  nickname            博主昵称（必填，位置参数）
  --product           产品名称（必填）
  --desc              合作内容介绍（必填）
  --start / --end     期望发布时间起止（必填，YYYY-MM-DD）
  --wechat            微信号（联系方式=微信时必填）
  --phone             手机号（联系方式=手机号时必填，与 --wechat 二选一）
  --contact           联系方式：微信/手机号，默认 微信
  --note-type         合作类型：图文/视频，默认 图文
  --coop-request      合作诉求：笔记合作/直播合作，默认 笔记合作
  --coop-mode         合作模式：定制合作/种收联动，默认 定制合作
  --coop-channel      建联方式：线上邀约，默认 线上邀约
  --port              CDP 端口，默认 9222
  --dry-run           只填写不提交（用于验证）

固定安全设计：
  - 任意一步失败即中止，绝不盲目提交
  - 提交前打印全部字段核对，与目标值不一致则中止
"""
import argparse
import json
import sys
import time
import uuid

import playwright.sync_api

SEARCH_API = "https://pgy.xiaohongshu.com/api/solar/cooperator/blogger/v2"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fail(msg):
    log("!! 中止: " + msg)
    sys.exit(1)


def js_search(nickname, uid_track):
    payload = {
        "searchType": 2, "column": "comprehensiverank", "sort": "desc",
        "pageNum": 1, "pageSize": 20, "brandUserId": "",
        "trackId": f"kolSearch_{uid_track}", "keyword": nickname,
        "gender": "", "location": None, "signed": -1, "featureTags": [],
        "fansAge": 0, "fansGender": 0, "fansLocation": None,
        "fansMaritalStatus": -1, "fansConsumptionLevel": -1, "fansChildAgeInfo": [],
        "fansDevicePrice": [], "fansDeviceBrand": [],
        "accumCommonImpMedinNum30d": [], "readMidNor30": [], "interMidNor30": [],
        "thousandLikePercent30": [], "noteType": 0,
        "notePriceLower": 0, "notePriceUpper": 10000000,
        "fansNumberLower": 0, "fansNumberUpper": 5000000,
        "progressOrderCnt": [], "tradeType": "不限", "tradeReportBrandIdSet": [],
        "excludedTradeReportBrandId": False, "estimateCpuv30d": [], "inStar": 0,
        "firstIndustry": "", "secondIndustry": "", "newHighQuality": 0,
        "filterIntention": False,
        "flagList": [{"flagType": "HAS_BRAND_COOP_BUYER_AUTH", "flagValue": "0"},
                     {"flagType": "IS_HIGH_QUALITY", "flagValue": "0"}],
        "activityCodes": [], "excludeLowActive": False, "fansNumUp": 0,
        "excludedTradeReportBrand": False, "excludedTradeInviteReportBrand": False,
        "filterList": [], "contentSceneLabel": [],
    }
    body = json.dumps(payload, ensure_ascii=False)
    return f"""fetch("{SEARCH_API}", {{
      method: "POST", credentials: "include",
      headers: {{ "Content-Type": "application/json", "Accept": "application/json" }},
      body: JSON.stringify({body})
    }}).then(r => r.ok ? r.json() : r.text().then(t => {{ throw new Error(`HTTP ${{r.status}}: ${{t.slice(0,200)}}`) }}))"""


def click_text(page, text, retries=6, wait=1.0):
    """点击全页面文本恰好等于 text 的最小可见元素。返回 True/False。"""
    for _ in range(retries):
        ok = page.evaluate("""({text}) => {
            let best = null;
            for (const el of document.querySelectorAll('button, span, div, a, li, td')) {
                const t = (el.textContent || '').trim();
                if (t === text && el.offsetParent !== null && el.getBoundingClientRect().width > 0) {
                    if (!best || el.getBoundingClientRect().height < best.getBoundingClientRect().height) best = el;
                }
            }
            if (best) { best.scrollIntoView({block: 'center'}); best.click(); return true; }
            return false;
        }""", {"text": text})
        if ok:
            return True
        time.sleep(wait)
    return False


def click_radio(page, text):
    """点击文本精确匹配的 radio 选项（.d-radio-main-label）。"""
    return page.evaluate("""({text}) => {
        for (const l of document.querySelectorAll('.d-radio-main-label')) {
            if ((l.textContent||'').trim() === text && l.offsetParent !== null) { l.click(); return true; }
        }
        return false;
    }""", {"text": text})


def find_form_page(ctx):
    for pg in ctx.pages:
        if "invite-form" in pg.url:
            return pg
    return None


def parse_ymd(date_str):
    y, m, d = date_str.split("-")
    return int(y), int(m), int(d)


def main():
    ap = argparse.ArgumentParser(description="蒲公英博主笔记合作邀约")
    ap.add_argument("nickname", help="博主昵称")
    ap.add_argument("--product", required=True, help="产品名称")
    ap.add_argument("--desc", required=True, help="合作内容介绍")
    ap.add_argument("--start", required=True, help="期望发布开始日期 YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="期望发布结束日期 YYYY-MM-DD")
    ap.add_argument("--wechat", default="", help="微信号（联系方式=微信时）")
    ap.add_argument("--phone", default="", help="手机号（联系方式=手机号时）")
    ap.add_argument("--contact", default="微信", choices=["微信", "手机号"])
    ap.add_argument("--note-type", default="图文", choices=["图文", "视频"])
    ap.add_argument("--coop-request", default="笔记合作", choices=["笔记合作", "直播合作"])
    ap.add_argument("--coop-mode", default="定制合作", choices=["定制合作", "种收联动"])
    ap.add_argument("--coop-channel", default="线上邀约", choices=["线上邀约"])
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--dry-run", action="store_true", help="只填写不提交")
    args = ap.parse_args()

    if args.contact == "微信" and not args.wechat:
        fail("联系方式=微信时请传 --wechat 微信号")
    if args.contact == "手机号" and not args.phone:
        fail("联系方式=手机号时请传 --phone 手机号")

    cdp = f"http://127.0.0.1:{args.port}"
    log("连接 Chrome CDP " + cdp)
    with playwright.sync_api.sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(cdp)
        except Exception as e:
            fail(f"无法连接 {args.port}（{e}）。请确认带 --remote-debugging-port={args.port} 的 Chrome 已启动且蒲公英已登录。")
        ctx = browser.contexts[0]

        # 1. 复用已有 invite-form 页面；否则走完整流程
        form = find_form_page(ctx)
        if form:
            log("检测到已打开的邀约表单页，直接使用")
            page = form
        else:
            # 2. 搜索博主
            main_page = None
            for pg in ctx.pages:
                if "pgy.xiaohongshu.com" in pg.url:
                    main_page = pg
                    break
            if main_page is None:
                main_page = ctx.new_page()
            log("搜索博主: " + args.nickname)
            data = main_page.evaluate(js_search(args.nickname, uuid.uuid4().hex))
            if not data:
                fail("搜索无返回")
            kols = ((data.get("data") or {}).get("kols") or [])
            uid = None
            for k in kols:
                nm = k.get("nickname") or k.get("name")
                if nm == args.nickname:
                    uid = k.get("userId")
                    break
            if not uid:
                fail(f"搜索未找到 {args.nickname}（total={data.get('data',{}).get('total')}）")
            log(f"找到 userId={uid}")

            # 3. 进入详情页
            main_page.goto(f"https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/{uid}",
                           wait_until="domcontentloaded", timeout=60000)
            time.sleep(4)
            try:
                main_page.evaluate("() => { const c=document.querySelector('.d-modal-close'); if(c) c.click(); }")
                time.sleep(0.5)
            except Exception:
                pass
            if args.nickname not in main_page.inner_text("body"):
                fail("详情页未加载出博主名，请确认登录态")

            # 4. 点击邀约，打开弹窗
            def modal_visible(pg):
                return pg.evaluate("""() => {
                    for (const el of document.querySelectorAll('.d-modal-mask, [class*=modal], [class*=dialog]')) {
                        const t = (el.innerText||'');
                        const r = el.getBoundingClientRect();
                        if (r.width>0 && r.height>100 && t.includes('合作诉求') && t.includes('发起邀约')) return true;
                    }
                    return false;
                }""")

            log("点击【邀约】")
            for _ in range(3):
                main_page.evaluate("""() => {
                    const cands = Array.from(document.querySelectorAll('button, div, span, a'));
                    let best = null;
                    for (const el of cands) {
                        const t = (el.textContent||'').trim();
                        if (t !== '邀约') continue;
                        const r = el.getBoundingClientRect();
                        if (r.width<=0 || r.height<=0 || r.height>120 || r.top<80) continue;
                        if (!best || r.height < best.height) best = el;
                    }
                    if (best) { best.scrollIntoView({block:'center'}); best.click(); return true; }
                    return false;
                }""")
                time.sleep(2.0)
                if modal_visible(main_page):
                    break
            if not modal_visible(main_page):
                fail("邀约弹窗未打开（已尝试点击，请确认详情页已加载、登录态正常）")
            log("邀约弹窗已打开")

            # 5. 选择 合作诉求/合作模式/建联方式
            for opt in [args.coop_request, args.coop_mode, args.coop_channel]:
                if not click_radio(main_page, opt):
                    fail(f"弹窗里选不到【{opt}】")
                log(f"已选: {opt}")
                time.sleep(0.5)

            # 6. 点击发起邀约
            log("点击【发起邀约】")
            if not main_page.evaluate("""() => {
                for (const b of document.querySelectorAll('button')) {
                    if ((b.textContent||'').trim() === '发起邀约' && b.offsetParent !== null) { b.click(); return true; }
                }
                return false;
            }"""):
                fail("弹窗里找不到【发起邀约】按钮")
            time.sleep(4)

            # 7. 找到表单页（轮询等待最多 15 秒）
            form = None
            for _ in range(15):
                time.sleep(1)
                form = find_form_page(ctx)
                if form is not None:
                    break
            if form is None:
                for i2, pg in enumerate(ctx.pages):
                    log(f"  当前 page[{i2}]: {pg.url}")
                fail("未出现邀约表单页（invite-form），请把上面页面列表发我")
            log("邀约表单页已打开: " + form.url)
            page = form

        time.sleep(1.5)

        # 8. 合作类型（图文/视频）
        note_sel = "图文笔记一口价" if args.note_type == "图文" else "视频笔记一口价"
        note_active = page.evaluate("""() => {
            const el = document.querySelector('.note-video-select[class*=active], .note-video-select-active');
            return el ? (el.textContent||'').trim() : 'none';
        }""")
        if args.note_type == "图文" and "图文" in (note_active or ""):
            log("合作类型: 图文笔记 ✅")
        elif args.note_type == "视频" and "视频" in (note_active or ""):
            log("合作类型: 视频笔记 ✅")
        else:
            if not click_text(page, note_sel):
                fail(f"无法选择合作类型 {note_sel}")
            time.sleep(0.5)
            log("合作类型已切换: " + note_sel)

        # 9. 联系方式（微信/手机号）
        ct = page.evaluate("""() => {
            const labels = document.querySelectorAll('.d-radio-main-label');
            for (const l of labels) {
                const sim = l.querySelector('.d-radio-simulator');
                if (sim && sim.className.includes('checked')) return (l.textContent||'').trim();
            }
            return 'none';
        }""")
        if ct != args.contact:
            if not click_radio(page, args.contact):
                fail(f"无法选择联系方式={args.contact}")
            time.sleep(0.5)
        log("联系方式: " + args.contact + " ✅")

        contact_val = args.wechat if args.contact == "微信" else args.phone

        def set_input(page, sel, value):
            return page.evaluate("""({sel, value}) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                const proto = el.tagName === 'TEXTAREA'
                    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                setter.call(el, value);
                el.dispatchEvent(new Event('input', {bubbles:true}));
                el.dispatchEvent(new Event('change', {bubbles:true}));
                return el.value === value;
            }""", {"sel": sel, "value": value})

        # 联系方式输入框（微信/手机号共用 placeholder="请输入"）
        if not set_input(page, 'input[placeholder="请输入"]', contact_val):
            fail(f"{args.contact}输入框找不到")
        log(f"{args.contact}: " + contact_val + " ✅")

        if not set_input(page, 'input[placeholder="请输入产品名称"]', args.product):
            fail("产品名称输入框找不到")
        log("产品名称: " + args.product + " ✅")

        desc_ok = page.evaluate("""({value}) => {
            const tas = document.querySelectorAll('textarea');
            for (const t of tas) {
                if ((t.getAttribute('placeholder')||'') === '有什么问题尽管问我') continue;
                const proto = window.HTMLTextAreaElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                setter.call(t, value);
                t.dispatchEvent(new Event('input', {bubbles:true}));
                t.dispatchEvent(new Event('change', {bubbles:true}));
                return t.value === value;
            }
            return false;
        }""", {"value": args.desc})
        if not desc_ok:
            fail("合作内容介绍输入框找不到")
        log("合作内容介绍: " + args.desc + " ✅")

        # 10. 期望发布时间
        log("设置期望发布时间: " + args.start + " ~ " + args.end)

        def get_date_vals(pg):
            return pg.evaluate("""() => {
                const out = [];
                document.querySelectorAll('.d-daterangepicker-wrapper input').forEach(i => out.push(i.value));
                return out;
            }""")

        def picker_disp(pg):
            return pg.evaluate("() => { const c=document.querySelector('.d-daterangepicker-content'); return c ? (c.textContent||'').trim() : ''; }")

        def dates_ok(ds):
            return args.start in ds and args.end in ds

        # 10.1 键盘输入法（模拟真实输入，React 组件通常响应）
        try:
            start_inp = page.locator('.d-daterangepicker-wrapper input').first
            end_inp = page.locator('.d-daterangepicker-wrapper input').nth(1)
            start_inp.fill("")
            start_inp.fill(args.start)
            start_inp.press("Enter")
            page.wait_for_timeout(400)
            end_inp.fill("")
            end_inp.fill(args.end)
            end_inp.press("Enter")
            page.wait_for_timeout(600)
        except Exception as e:
            log("键盘输入异常: " + str(e)[:100])

        dates = get_date_vals(page)
        log("键盘输入后日期值: " + json.dumps(dates, ensure_ascii=False) + " | 显示: " + picker_disp(page))
        if dates_ok(dates):
            log("日期设置成功（键盘输入）")
        else:
            # 10.2 面板法：清空输入框 -> 打开面板 -> 按月份精确点选本月格子
            log("键盘输入未生效，改用日历面板点选")
            sy, sm, sd = parse_ymd(args.start)
            ey, em, ed = parse_ymd(args.end)
            try:
                start_inp = page.locator('.d-daterangepicker-wrapper input').first
                end_inp = page.locator('.d-daterangepicker-wrapper input').nth(1)
                start_inp.fill("")
                end_inp.fill("")
            except Exception:
                pass
            page.wait_for_timeout(300)

            def panel_open(pg):
                return pg.evaluate("() => { const b=document.querySelector('.d-daterangepicker-body'); return b && b.offsetParent!==null && b.getBoundingClientRect().height>0; }")

            def open_calendar(pg):
                pg.evaluate("() => { const w=document.querySelector('.d-daterangepicker-wrapper'); if(w) w.scrollIntoView({block:'center'}); }")
                time.sleep(0.8)
                try:
                    box = pg.locator(".d-daterangepicker-wrapper").bounding_box()
                    if box:
                        pg.mouse.click(box["x"] + box["width"]*0.2, box["y"] + box["height"]*0.5)
                except Exception:
                    pass
                time.sleep(1.2)
                if not panel_open(pg):
                    pg.evaluate("() => { const i=document.querySelector('.d-daterangepicker-wrapper input'); if(i) i.click(); }")
                    time.sleep(1.2)
                if not panel_open(pg):
                    pg.evaluate("() => { const w=document.querySelector('.d-daterangepicker-wrapper'); if(w) w.click(); }")
                    time.sleep(1.2)
                return panel_open(pg)

            def click_in_month(pg, year, month, day):
                return pg.evaluate("""({year, month, day}) => {
                    for (const pn of document.querySelectorAll('.d-datepicker-calendar')) {
                        const t = (pn.innerText||'').replace(/\\n+/g,' ');
                        const m = t.match(/(\\d{4})年\\s*(\\d{1,2})月/);
                        if (!m) continue;
                        if (m[1] === String(year) && String(parseInt(m[2],10)) === String(month)) {
                            for (const cell of pn.querySelectorAll('.d-datepicker-cell, td')) {
                                const cls = (cell.className||'').toString();
                                if (cls.includes('--color-text-pla')) continue; // 跳过灰色填充日期
                                if ((cell.textContent||'').trim() === String(day) && cell.offsetParent!==null) {
                                    cell.scrollIntoView({block:'center'});
                                    cell.click();
                                    return true;
                                }
                            }
                        }
                    }
                    return false;
                }""", {"year": year, "month": month, "day": day})

            if not open_calendar(page):
                fail("日历面板打不开（中止，未提交）")
            months = page.evaluate("""() => {
                const out = [];
                document.querySelectorAll('.d-datepicker-calendar').forEach(pn => {
                    const t = (pn.innerText||'').replace(/\\n+/g,' ').trim();
                    const m = t.match(/(\\d{4})年\\s*(\\d{1,2})月/);
                    out.push(m ? m[1]+'-'+m[2] : t.slice(0,20));
                });
                return out;
            }""")
            log("面板月份: " + json.dumps(months, ensure_ascii=False))

            if not click_in_month(page, sy, sm, sd):
                fail(f"面板中找不到 {args.start}（中止，未提交）")
            log("已点选 " + args.start)
            time.sleep(1.0)
            if not panel_open(page):
                if not open_calendar(page):
                    fail("面板关闭且无法重新打开")
            if not click_in_month(page, ey, em, ed):
                fail(f"面板中找不到 {args.end}（中止，未提交）")
            log("已点选 " + args.end)
            time.sleep(1.2)

        # 11. 核对日期
        dates = get_date_vals(page)
        log("日期输入框当前值: " + json.dumps(dates, ensure_ascii=False))
        log("期望发布时间显示: " + picker_disp(page))
        if not dates_ok(dates):
            fail("日期未正确设置，中止提交（请把上面日志发我）")

        # 12. 核对全部字段
        final = page.evaluate("""() => {
            const out = {};
            const contact = document.querySelector('input[placeholder="请输入"]');
            const prod = document.querySelector('input[placeholder="请输入产品名称"]');
            out.contact = contact ? contact.value : null;
            out.product = prod ? prod.value : null;
            const tas = document.querySelectorAll('textarea');
            for (const t of tas) { if ((t.getAttribute('placeholder')||'') !== '有什么问题尽管问我') { out.desc = t.value; break; } }
            const dates = [];
            document.querySelectorAll('.d-daterangepicker-wrapper input').forEach(i => dates.push(i.value));
            out.dates = dates;
            return out;
        }""")
        log("===== 提交前最终核对 =====")
        log(f"  联系方式: {args.contact} | 值: {str(final.get('contact'))}")
        log("  产品名称: " + str(final.get("product")))
        log("  合作内容: " + str(final.get("desc")))
        log("  期望发布时间: " + json.dumps(final.get("dates"), ensure_ascii=False))
        if (final.get("contact") != contact_val or final.get("product") != args.product
                or final.get("desc") != args.desc or args.start not in (final.get("dates") or [])
                or args.end not in (final.get("dates") or [])):
            fail("字段核对不一致，中止提交")

        # 13. 提交
        if args.dry_run:
            log("dry-run 模式，不提交。字段已全部填好，可手动点【发起邀约】提交。")
            return
        log("点击【发起邀约】提交...")
        if not click_text(page, "发起邀约", retries=3):
            fail("找不到提交按钮")
        time.sleep(4)
        log("提交动作已完成")
        log("当前页面URL: " + page.url)
        try:
            tail = page.inner_text("body")[-500:]
            log("页面尾部文本: " + tail[:300])
        except Exception:
            pass
        log("脚本结束。请到蒲公英后台确认邀约是否出现在邀约列表中。")


if __name__ == "__main__":
    main()
