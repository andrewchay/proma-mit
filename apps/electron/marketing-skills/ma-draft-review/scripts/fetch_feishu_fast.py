#!/usr/bin/env python3
"""
fetch_feishu_fast.py — 快速抓取飞书 docx 正文+配图（替代 kol_collector.py 双程滚动慢速方案）

原理：飞书 docx 是虚拟化渲染，正文/图片按视口懒加载。本脚本在页面内注入
MutationObserver，在高速双程滚动过程中实时收集所有进入 DOM 的 [data-block-id]
文本块与 <img> 元素，避免"滚动完成后二次读 DOM"导致漏块/重复等待。

验证：单份稿件约 5 秒（原方案 1-3 分钟）。

用法：
    python3 fetch_feishu_fast.py --port 9222 --url '<飞书docx链接>' --out '<输出目录>'

输出：
    out/text.txt      全文（已过滤 UI 噪音与连续重复）
    out/raw_texts.txt 原始收集文本（调试用）
    out/images.json    配图清单（已剔除页面头像，编号从 1 开始）
    out/*.jpg/.png     下载的配图

图片下载复用页面登录态 Cookie（CDP 浏览器需已登录飞书）。
"""
import argparse
import asyncio
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from playwright.async_api import async_playwright

# 页面内高速收集：MutationObserver + 双程滚动
FAST_JS = r"""
async () => {
  const root = document.querySelector('.bear-web-x-container') || document.scrollingElement || document.documentElement;
  const blocks = new Map();
  const imgSeen = new Set();
  const imgs = [];
  const collect = () => {
    for (const el of document.querySelectorAll('[data-block-id]')) {
      const id = el.getAttribute('data-block-id');
      if (!id || blocks.has(id)) continue;
      const t = (el.innerText || '').trim();
      if (t) blocks.set(id, t);
    }
    for (const el of document.querySelectorAll('img')) {
      const u = el.currentSrc || el.src || '';
      if (!u || u.startsWith('data:') || imgSeen.has(u)) continue;
      imgSeen.add(u);
      const r = el.getBoundingClientRect();
      imgs.push({ url: u, alt: el.alt || '', w: el.naturalWidth || Math.round(r.width), h: el.naturalHeight || Math.round(r.height) });
    }
  };
  collect();
  const mo = new MutationObserver(collect);
  mo.observe(document.body, { childList: true, subtree: true });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let pos = 0;
  while (true) {
    pos += 800;
    root.scrollTop = pos;
    await sleep(60);
    collect();
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 10) break;
  }
  pos = root.scrollHeight;
  while (true) {
    pos -= 800;
    root.scrollTop = Math.max(0, pos);
    await sleep(50);
    collect();
    if (root.scrollTop <= 10) break;
  }
  root.scrollTop = 0;
  await sleep(250);
  collect();
  mo.disconnect();
  return { texts: Array.from(blocks.values()), imgs };
}
"""

MIME_EXT = {
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
    "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
}

# UI 噪音文本（编辑器工具栏等，非稿件内容）
NOISE = {"添加图标", "添加封面", "展示文档信息", "本文暂未被其它文档引用"}
ZERO_WIDTH = "​‌‍﻿⁠"

def strip_zero(s):
    return "".join(c for c in s if c not in ZERO_WIDTH).strip()

def clean_texts(texts):
    out = []
    for raw in texts:
        t = strip_zero(raw)
        if not t or any(n in t for n in NOISE):
            continue
        if out and out[-1] == t:
            continue
        out.append(t)
    return out

def is_avatar(im):
    # 页面头像固定出现在 static-resource 域且为 v3_0013j_ 资源；内容图在 internal-api-drive-stream
    return "static-resource" in im["url"]

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()
    dl = []
    texts = []
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(f"http://127.0.0.1:{args.port}")
        ctx = browser.contexts[0]
        page = await ctx.new_page()
        try:
            await page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(2500)
            data = await page.evaluate(FAST_JS)
            texts = clean_texts(data["texts"])
            imgs = [im for im in data["imgs"] if not is_avatar(im)]
            print(f"[OK] 抓取完成 {time.time()-t0:.1f}s | 文本块 {len(texts)} | 配图 {len(imgs)}（已剔头像）")
            # 并发下载图片：复用登录 Cookie 的 context.request（真并发 HTTP，不占页面）
            sem = asyncio.Semaphore(5)
            async def dl_one(idx, im):
                async with sem:
                    r = await ctx.request.get(im["url"])
                    if not r.ok:
                        print(f"  [!] 图片{idx} 下载失败: HTTP {r.status}")
                        return None
                    body = await r.body()
                    ct = r.headers.get("content-type", "")
                    ext = MIME_EXT.get(ct.split(";")[0], "jpg")
                    fn = f"{idx:03d}_image.{ext}"
                    with open(os.path.join(args.out, fn), "wb") as f:
                        f.write(body)
                    return {"file": os.path.join(args.out, fn), "width": im["w"], "height": im["h"], "alt": im["alt"], "url": im["url"]}
            tasks = [asyncio.create_task(dl_one(i + 1, im)) for i, im in enumerate(imgs)]
            dl = [x for x in await asyncio.gather(*tasks) if x]
        finally:
            await page.close()
            await browser.close()
    el = time.time() - t0

    with open(os.path.join(args.out, "text.txt"), "w") as f:
        f.write("\n".join(texts))
    with open(os.path.join(args.out, "raw_texts.txt"), "w") as f:
        f.write("\n".join(data["texts"]))
    with open(os.path.join(args.out, "images.json"), "w") as f:
        json.dump(dl, f, ensure_ascii=False, indent=2)
    print(f"[OK] 已下载 {len(dl)} 张配图 -> {args.out} | 总耗时 {el:.1f}s")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(1)
