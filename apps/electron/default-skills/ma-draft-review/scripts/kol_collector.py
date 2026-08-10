#!/usr/bin/env python3
"""
kol_collector.py — 飞书稿件审核辅助脚本（当前仅提供 --check 自检）

ma-draft-review 在读取飞书文档 / wiki / 网页链接稿件前，先运行自检：
1. Chrome CDP 远程调试端口是否开启
2. 飞书网页版登录态是否正常（通过 CDP 打开 www.feishu.cn 判断是否跳转登录页）

用法：python3 scripts/kol_collector.py --check --port 9222
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

FEISHU_WEB_URL = "https://www.feishu.cn/"


def check_cdp(port: int) -> bool:
    """检查 CDP 端口是否开启"""
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/json/version", timeout=3
        ) as resp:
            info = json.loads(resp.read().decode("utf-8"))
            print(f"[OK] CDP 已开启: {info.get('Browser', 'Chrome')}")
            return True
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] CDP 未开启（{exc}）")
        print("请按以下任一方式启动带调试端口的 Chrome，并登录 https://www.feishu.cn/：")
        print("  A（推荐，隔离配置）：")
        print("    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\")
        print(f"      --remote-debugging-port={port} --user-data-dir=/tmp/chrome_pgy_debug")
        print("  B（复用已登录的主 Chrome）：先退出所有 Chrome，再执行同样的命令（不带 --user-data-dir）。")
        return False


def check_feishu_login(port: int) -> bool:
    """通过 CDP 打开飞书网页版，判断登录态是否正常"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("[FAIL] 未安装 playwright Python 包，请运行: pip install playwright")
        return False

    try:
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            contexts = browser.contexts
            if not contexts:
                print("[FAIL] CDP 无可用浏览器上下文")
                return False
            # 在用户默认上下文新建标签页检查，用完即关（不关闭用户浏览器）
            page = contexts[0].new_page()
            try:
                page.goto(FEISHU_WEB_URL, wait_until="domcontentloaded", timeout=15000)
                page.wait_for_timeout(2500)  # 等待可能的登录跳转
                url = page.url
                if "passport" in url or "/login" in url or "login" in page.title().lower():
                    print(
                        f"[FAIL] 飞书登录态异常，请先在 Chrome 中登录 https://www.feishu.cn/（当前跳转: {url}）"
                    )
                    return False
                print(f"[OK] 飞书登录态正常（{url}）")
                return True
            finally:
                page.close()
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 飞书登录态检查失败: {exc}")
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="飞书稿件审核辅助脚本")
    parser.add_argument("--check", action="store_true", help="检查 CDP 与飞书登录态")
    parser.add_argument("--port", type=int, default=9222, help="Chrome CDP 远程调试端口")
    args = parser.parse_args()

    if not args.check:
        print("暂仅支持 --check 模式", file=sys.stderr)
        sys.exit(1)

    ok = True
    if not check_cdp(args.port):
        ok = False
    if ok and not check_feishu_login(args.port):
        ok = False
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
