#!/usr/bin/env python3
"""
蒲公英参数探索脚本（参考模板）
对应 ma-kol-scraper skill 的 Step 2 · 初筛阶段

功能：
1. CDP 连接 Chrome，优先复用已打开的蒲公英页面
2. 登录态检查 + 全页截图保存
3. 多策略兜底识别页面 UI 组件（筛选栏/下拉框/Tab/标签组）
4. 提取下拉框 trigger、标签文本、筛选栏整段文本
5. 逐个点击下拉框展开，提取弹出选项
6. 从 localStorage/URL/Cookie 提取品牌信息

所有输出文件写入当前会话的独立目录（SESSION_DIR）。
生成定制化脚本时，将 SESSION_DIR 替换为实际路径。"""
import json, os, time
import playwright.sync_api

SESSION_DIR = "<session-dir>"
CDP_PORT = 9222

with playwright.sync_api.sync_playwright() as p:
    print("正在连接 Chrome CDP...")
    browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
    context = browser.contexts[0]

    main_page = None
    for pg in context.pages:
        url = pg.url
        if "pgy.xiaohongshu.com" in url:
            main_page = pg
            print(f"找到蒲公英页面: {url[:100]}")
            break
    if not main_page:
        print("未找到蒲公英页面，新建标签页...")
        main_page = context.new_page()
        main_page.goto(
            "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
            wait_until="domcontentloaded", timeout=60000
        )
        time.sleep(3)

    body_text = main_page.inner_text("body")
    if "账号登录" in body_text or "立即登录" in body_text[:200]:
        print("\n⚠️ 未检测到登录态！请手动登录后再继续。")
        input("按 Enter 继续...")
        main_page.goto(
            "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
            wait_until="domcontentloaded", timeout=60000
        )
        time.sleep(3)

    print("✅ 页面已加载，开始探索参数...\n")

    os.makedirs(SESSION_DIR, exist_ok=True)
    main_page.screenshot(
        path=os.path.join(SESSION_DIR, "pgy_screenshot_explore.png"),
        full_page=True
    )
    print("✅ 截图已保存\n")

    strategies = {}
    selectors = {
        "A_筛选栏": [".common-filters-wrapper", ".note-filters-wrapper", ".filter-bar", ".d-filter"],
        "B_下拉框": [".d-select", ".ant-select", ".el-select"],
        "C_Tab栏": [".d-tabs-header-label", ".ant-tabs-tab", ".el-tabs__item"],
        "D_标签组": [".d-tag-group", ".filter-tags", ".tag-list", ".d-tag"],
    }
    for strategy, sel_list in selectors.items():
        for sel in sel_list:
            try:
                count = main_page.evaluate(f"document.querySelectorAll('{sel}').length")
                if count > 0:
                    strategies[strategy] = {"selector": sel, "count": count}
                    break
            except:
                pass
    print("=== 找到的UI组件 ===")
    for s, info in strategies.items():
        print(f"  {s}: selector={info['selector']}, count={info['count']}")

    print("\n=== 提取页面参数 ===")

    for sel_name, sel in [
        ("d-select", ".d-select"),
        ("ant-select", ".ant-select"),
        ("el-select", ".el-select"),
    ]:
        try:
            texts = main_page.evaluate(f"""() => {{
                const els = document.querySelectorAll('{sel}');
                return Array.from(els).map(el => ({{
                    trigger: (el.querySelector('.d-select-label, .ant-select-selection-item, input') || el)
                        .textContent.trim().slice(0, 50),
                    class: el.className.slice(0, 100)
                }})).slice(0, 20);
            }}""")
            if texts and len(texts) > 0:
                print(f"\n  [{sel_name}] 下拉框 ({len(texts)}个):")
                for t in texts[:10]:
                    print(f"    - trigger: '{t['trigger']}' | class: {t['class']}")
        except Exception:
            pass

    try:
        tags = main_page.evaluate("""() => {
            const all = document.querySelectorAll(
                '.d-tag, .d-tag-group span, [class*=filter] span, ' +
                '.d-checkbox-label, .d-segment-item'
            );
            return Array.from(all).map(el => el.textContent.trim())
                .filter(t => t.length > 0 && t.length < 30).slice(0, 80);
        }""")
        unique_tags = list(dict.fromkeys(tags))
        if unique_tags:
            print(f"\n  [标签/Tab] ({len(unique_tags)}个):")
            for t in unique_tags:
                print(f"    - {t}")
    except Exception:
        pass

    for fb_sel in [
        ".common-filters-wrapper", ".note-filters-wrapper",
        ".filter-bar", "main", ".page-content",
    ]:
        try:
            text = main_page.evaluate(f"""() => {{
                const el = document.querySelector('{fb_sel}');
                if (!el) return null;
                return el.innerText.slice(0, 3000);
            }}""")
            if text:
                print(f"\n  [筛选栏 {fb_sel}] 文本:")
                for line in text.split('\n'):
                    line = line.strip()
                    if line:
                        print(f"    {line}")
                break
        except:
            pass

    print("\n\n=== 尝试展开下拉框获取选项 ===")
    for sel in [".d-select", ".ant-select-selector", ".el-select"]:
        try:
            count = main_page.evaluate(f"document.querySelectorAll('{sel}').length")
            if count > 0:
                for i in range(min(count, 5)):
                    try:
                        main_page.evaluate(f"""() => {{
                            const el = document.querySelectorAll('{sel}')[{i}];
                            if (el) el.click();
                            return true;
                        }}""")
                        time.sleep(0.8)
                        options = main_page.evaluate("""() => {
                            const items = document.querySelectorAll(
                                '.d-dropdown-item, .d-select-option, ' +
                                '.d-dropdown-content div, .ant-select-item-option, ' +
                                '.el-select-dropdown__item'
                            );
                            return Array.from(items).map(el => el.textContent.trim())
                                .filter(t => t.length > 0 && t.length < 30).slice(0, 50);
                        }""")
                        if options:
                            unique_opts = list(dict.fromkeys(options))
                            print(f"  [{sel} #{i}] 选项: {unique_opts}")
                        main_page.evaluate("document.body.click()")
                        time.sleep(0.5)
                    except:
                        pass
        except:
            pass

    print("\n\n=== 尝试获取品牌信息 ===")
    try:
        brand_items = main_page.evaluate("""() => {
            try {
                return Object.entries(localStorage)
                    .filter(([k]) => k.includes('brand') || k.includes('user'))
                    .slice(0, 5);
            } catch(e) { return []; }
        }""")
        if brand_items:
            print(f"  localStorage品牌信息: {brand_items}")
    except:
        pass
    print(f"\n  当前URL: {main_page.url}")
    try:
        cookies = context.cookies()
        for c in cookies:
            if any(k in c['name'].lower() for k in ('brand', 'user', 'token')):
                print(f"  Cookie: {c['name']} = {c['value'][:50]}")
    except:
        pass

    print("\n✅ 参数探索完成！")
