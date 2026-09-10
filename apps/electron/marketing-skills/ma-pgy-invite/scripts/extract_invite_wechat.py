#!/usr/bin/env python3
"""从蒲公英"我的邀约"提取意向为"感兴趣"的博主微信号，输出 CSV。

原理：
  1. 打开"我的邀约"列表页，找出意向 = "感兴趣" 的博主行
  2. 逐行点击"查看详情"，在详情抽屉里按标签"博主微信"读取微信值（明文）
  3. 若读到的是掩码（纯星号），尝试点击该值行触发解密后再读
  4. 输出 CSV（表头：博主名称, 微信号）

用法（确保 Chrome 已开 9222 并登录蒲公英，且停留在蒲公英任一页面）：
  python3 extract_invite_wechat.py [--out 输出csv路径] [--port 9222]

说明：
  - 只处理意向="感兴趣"的博主
  - 默认输出到 工作区 workspace-files/邀约博主微信.csv
"""
import argparse
import csv
import os
import sys
import time

import playwright.sync_api

LIST_URL = "https://pgy.xiaohongshu.com/solar/pre-trade/brand/invite-list/note"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fail(msg):
    log("!! 中止: " + msg)
    sys.exit(1)


def get_interesting_rows(page):
    """在邀约列表表格里找意向=感兴趣的行，返回博主名称列表。"""
    return page.evaluate("""() => {
        const out = [];
        const table = document.querySelector('.d-table-v2');
        const rows = table ? table.querySelectorAll('tbody tr, tr') : document.querySelectorAll('tr');
        for (const r of rows) {
            const txt = (r.textContent||'').trim();
            if (!txt.includes('感兴趣')) continue;
            const tds = Array.from(r.querySelectorAll('td, [class*=col], [class*=cell]'));
            let name = '';
            for (const td of tds) {
                const t = (td.textContent||'').trim();
                if (t && t.length > 1 && t.length < 30 && !/^[¥0-9-]/.test(t)
                        && !['感兴趣','查看详情','未跟进','暂不考虑'].includes(t) && !t.includes('至')) {
                    name = t; break;
                }
            }
            if (!name) {
                const parts = txt.split(/\\s+/).filter(Boolean);
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i] === '感兴趣') { name = parts[i-1] || ''; break; }
                }
            }
            if (name) out.push(name);
        }
        return out;
    }""")


def click_detail_by_row(page, name):
    return page.evaluate("""({name}) => {
        const table = document.querySelector('.d-table-v2');
        const rows = table ? table.querySelectorAll('tbody tr, tr') : document.querySelectorAll('tr');
        for (const r of rows) {
            const txt = (r.textContent||'');
            if (txt.includes(name) && txt.includes('感兴趣') && txt.includes('查看详情')) {
                const btns = r.querySelectorAll('button, a, span, div');
                for (const b of btns) {
                    if ((b.textContent||'').trim() === '查看详情' && b.offsetParent !== null) {
                        b.scrollIntoView({block:'center'}); b.click(); return true;
                    }
                }
            }
        }
        return false;
    }""", {"name": name})


def close_drawer(page):
    page.evaluate("() => { const c=document.querySelector('.invite-detail-drawer [class*=close]'); if(c) c.click(); }")
    time.sleep(0.6)
    page.evaluate("() => document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))")
    time.sleep(0.5)
    exists = page.evaluate("() => !!document.querySelector('.invite-detail-drawer')")
    if exists:
        page.evaluate("() => { const d=document.querySelector('.invite-detail-drawer'); const c=d&&d.querySelector('[class*=close],[class*=Close]'); if(c) c.click(); }")
        time.sleep(0.6)


def drawer_matches(page, name):
    """校验当前详情抽屉是否属于指定博主（含博主名）。"""
    return page.evaluate("""({name}) => {
        const d = document.querySelector('.invite-detail-drawer');
        if (!d) return false;
        return (d.textContent||'').includes(name);
    }""", {"name": name})


def read_wechat(page):
    """读详情抽屉里"博主微信"标签对应的值。返回 (值, 是否掩码)。"""
    info = page.evaluate("""() => {
        const d = document.querySelector('.invite-detail-drawer');
        if (!d) return null;
        const rows = d.querySelectorAll('.detail-list .flex.gap-16');
        for (const row of rows) {
            const left = row.querySelector('.item-left');
            const right = row.querySelector('.item-right');
            if (left && right && (left.textContent||'').trim() === '博主微信' && right) {
                // 只读值 span（d-text-nowrap），避免带上末尾的提示文案
                const valNode = right.querySelector('span.d-text-nowrap');
                let value = (valNode ? valNode.textContent : right.textContent).trim();
                const hint = '联系方式属于博主的重要个人信息';
                const hi = value.indexOf(hint);
                if (hi >= 0) value = value.slice(0, hi).trim();
                return {value, masked: /\\*/.test(value)};
            }
        }
        return null;
    }""")
    return info


def click_wechat_value(page):
    """点击微信行的眼睛图标(.cursor-animation)，触发脱敏字段解密（掩码->明文）。"""
    page.evaluate("""() => {
        const d = document.querySelector('.invite-detail-drawer');
        const rows = d.querySelectorAll('.detail-list .flex.gap-16');
        for (const row of rows) {
            const left = row.querySelector('.item-left');
            const right = row.querySelector('.item-right');
            if (left && right && (left.textContent||'').trim() === '博主微信' && right) {
                const eye = right.querySelector('span.d-icon.cursor-animation, .cursor-animation');
                if (eye) {
                    eye.scrollIntoView({block:'center'});
                    ['mousedown','mouseup','click'].forEach(t =>
                        eye.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true})));
                    return true;
                }
            }
        }
        return false;
    }""")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="", help="输出 CSV 路径")
    ap.add_argument("--port", type=int, default=9222)
    args = ap.parse_args()

    if not args.out:
        out_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "workspace-files", "邀约博主微信.csv")
    else:
        out_path = args.out

    cdp = f"http://127.0.0.1:{args.port}"
    log("连接 Chrome CDP " + cdp)
    with playwright.sync_api.sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(cdp)
        except Exception as e:
            fail(f"无法连接 {args.port}（{e}）。请确认带 --remote-debugging-port 的 Chrome 已启动且蒲公英已登录。")
        ctx = browser.contexts[0]

        page = None
        for pg in ctx.pages:
            if "invite-list" in pg.url:
                page = pg
                break
        if page is None:
            for pg in ctx.pages:
                if "pgy.xiaohongshu.com" in pg.url:
                    page = pg
                    break
        if page is None:
            page = ctx.new_page()
        if "invite-list" not in page.url:
            page.goto(LIST_URL, wait_until="domcontentloaded", timeout=60000)
            time.sleep(3)

        # 关闭可能开着的抽屉，刷新表格
        close_drawer(page)
        page.wait_for_timeout(500)

        names = get_interesting_rows(page)
        log(f"意向=感兴趣 的博主: {names}")
        if not names:
            fail("没有意向为'感兴趣'的博主，无需提取")

        results = []
        for i, name in enumerate(names, 1):
            log(f"[{i}/{len(names)}] 处理: {name}")
            if not click_detail_by_row(page, name):
                log(f"  !! 找不到 {name} 的查看详情行，跳过")
                results.append((name, ""))
                continue
            time.sleep(2)
            if not drawer_matches(page, name):
                time.sleep(2)
            if not drawer_matches(page, name):
                log(f"  !! 抽屉未切换到 {name}，跳过")
                close_drawer(page)
                results.append((name, ""))
                continue

            info = read_wechat(page)
            wechat = ""
            if info:
                wechat = info["value"]
                if info["masked"]:
                    log("  读到掩码，尝试点击解密...")
                    click_wechat_value(page)
                    time.sleep(1.0)
                    info2 = read_wechat(page)
                    if info2 and not info2["masked"]:
                        wechat = info2["value"]
                        log(f"  解密后微信号: {wechat}")
                    else:
                        log("  !! 仍是掩码，未取到明文微信号")
                else:
                    log(f"  微信号: {wechat}")
            else:
                log("  !! 详情里未找到'博主微信'字段")

            results.append((name, wechat))
            close_drawer(page)

        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["博主名称", "微信号"])
            for name, wechat in results:
                w.writerow([name, wechat])
        log("CSV 已写入: " + out_path)
        log("内容:")
        for name, wechat in results:
            log(f"  {name} | {wechat or '(未获取)'}")
        log("脚本结束。")


if __name__ == "__main__":
    main()
