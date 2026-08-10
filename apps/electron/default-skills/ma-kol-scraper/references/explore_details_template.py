#!/usr/bin/env python3
"""
蒲公英筛选选项展开脚本（参考模板）
对应 ma-kol-scraper skill 的 Step 2 · 细筛阶段

在 explore_params 初筛之后，针对具体的筛选分组逐个点击展开，
提取「博主类目 / 性别 / 地域 / 粉丝量 / 合作报价 / 笔记类目」
以及地域树、粉丝地域树中的具体可选值。

用于 Agent 在向用户展示选项前做完整枚举，避免让用户自由填写。
"""
import json, os, time
import playwright.sync_api

SESSION_DIR = "<session-dir>"
CDP_PORT = 9222

with playwright.sync_api.sync_playwright() as p:
    print("正在连接 Chrome CDP...")
    browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
    context = browser.contexts[0]

    page = None
    for pg in context.pages:
        if "pgy.xiaohongshu.com" in pg.url and "kol" in pg.url:
            page = pg
            break
    if not page:
        print("未找到蒲公英页面!")
        exit(1)

    print("✅ 已连接，开始展开筛选选项...\n")

    sections_to_explore = [
        ("博主类目", ".common-filters-wrapper"),
        ("性别", ".common-filters-wrapper"),
        ("地域", ".common-filters-wrapper"),
        ("粉丝量", ".common-filters-wrapper"),
        ("合作报价", ".common-filters-wrapper"),
        ("笔记类目", ".common-filters-wrapper"),
    ]

    all_results = {}

    for section_name, container in sections_to_explore:
        print(f"\n===== 展开: {section_name} =====")
        try:
            clicked = page.evaluate(f"""() => {{
                const container = document.querySelector('{container}') || document.body;
                const allEls = container.querySelectorAll('span, div, label');
                let found = null;
                for (const el of allEls) {{
                    if (el.textContent.trim() === '{section_name}'
                        && el.offsetParent !== null) {{
                        found = el;
                        break;
                    }}
                }}
                if (!found) return 'not found';
                found.scrollIntoView({{block: 'center'}});
                found.click();
                return 'clicked';
            }}""")
            print(f"  点击: {clicked}")
            time.sleep(1.5)

            options = page.evaluate("""() => {
                const allSelectors = [
                    '.d-dropdown-item', '.d-select-option',
                    '.ant-select-item-option', '.el-select-dropdown__item',
                    '.d-dropdown-content div', '.d-dropdown-content span',
                    '.d-dropdown .d-dropdown-item',
                    '.d-select-dropdown .d-select-item',
                    '.d-overlay-content *', '.d-popup-content *',
                    '[class*=popover] *', '[class*=dropdown] *',
                    '.d-checkbox-group label', '.d-radio-group label',
                ];
                const allItems = [];
                for (const sel of allSelectors) {
                    const els = document.querySelectorAll(sel);
                    for (const el of els) {
                        const txt = el.textContent.trim();
                        if (txt && txt.length < 40 && !allItems.includes(txt)) {
                            allItems.push(txt);
                        }
                    }
                }
                return allItems;
            }""")
            if options:
                print(f"  选项 ({len(options)}个):")
                for opt in options:
                    print(f"    - {opt}")
                all_results[section_name] = options
            else:
                panel_text = page.evaluate(f"""() => {{
                    const container = document.querySelector('{container}') || document.body;
                    return container.innerText.slice(0, 3000);
                }}""")
                print(f"  面板文本:")
                lines_out = []
                for line in panel_text.split('\n'):
                    line = line.strip()
                    if line and len(line) < 40:
                        print(f"    {line}")
                        lines_out.append(line)
                if lines_out:
                    all_results[section_name] = lines_out

            page.evaluate("document.body.click()")
            time.sleep(0.8)

        except Exception as e:
            print(f"  出错: {e}")
            try:
                page.evaluate("document.body.click()")
                time.sleep(0.5)
            except:
                pass

    print("\n\n===== 尝试提取地域选项 =====")
    area_options_out = []
    try:
        clicked = page.evaluate("""() => {
            const all = document.querySelectorAll(
                '.common-filters-wrapper span, .common-filters-wrapper div'
            );
            for (const el of all) {
                if (el.textContent.trim() === '地域' && el.offsetParent !== null) {
                    el.scrollIntoView({block: 'center'});
                    el.click();
                    return true;
                }
            }
            return false;
        }""")
        if clicked:
            time.sleep(2)
            area_options = page.evaluate("""() => {
                const items = document.querySelectorAll(
                    '.d-tree-node, .d-tree-item, ' +
                    '.d-cascader-menu-item, [class*=menu-item]'
                );
                return Array.from(items).map(el => el.textContent.trim())
                    .filter(t => t && t.length < 20).slice(0, 60);
            }""")
            if area_options:
                print(f"  地域选项 ({len(area_options)}个):")
                for opt in area_options:
                    print(f"    - {opt}")
                area_options_out = area_options
            page.evaluate("document.body.click()")
            time.sleep(0.5)
    except:
        pass
    if area_options_out:
        all_results["地域"] = area_options_out

    print("\n\n===== 尝试提取粉丝地域选项 =====")
    fans_area_out = []
    try:
        clicked = page.evaluate("""() => {
            const all = document.querySelectorAll(
                '.common-filters-wrapper span, .common-filters-wrapper div'
            );
            for (const el of all) {
                if (el.textContent.trim() === '粉丝地域' && el.offsetParent !== null) {
                    el.scrollIntoView({block: 'center'});
                    el.click();
                    return true;
                }
            }
            return false;
        }""")
        if clicked:
            time.sleep(2)
            options = page.evaluate("""() => {
                const items = document.querySelectorAll(
                    '.d-tree-node, .d-tree-item, ' +
                    '.d-cascader-menu-item, [class*=menu-item]'
                );
                return Array.from(items).map(el => el.textContent.trim())
                    .filter(t => t && t.length < 20).slice(0, 60);
            }""")
            if options:
                print(f"  粉丝地域选项 ({len(options)}个):")
                for opt in options:
                    print(f"    - {opt}")
                fans_area_out = options
            page.evaluate("document.body.click()")
            time.sleep(0.5)
    except:
        pass
    if fans_area_out:
        all_results["粉丝地域"] = fans_area_out

    os.makedirs(SESSION_DIR, exist_ok=True)
    with open(
        os.path.join(SESSION_DIR, "pgy_filter_options.json"),
        "w", encoding="utf-8"
    ) as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)
    print(f"\n✅ 探索完成！结果已写入 pgy_filter_options.json")
