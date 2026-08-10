# 蒲公英搜索 API Payload 参考（ma-kol-scraper）

> 搜索接口：`POST https://pgy.xiaohongshu.com/api/solar/cooperator/blogger/v2`
> 必须在浏览器 JS 上下文（`page.evaluate(fetch(...))`）中调用，浏览器自动附带 x-s / x-t 签名。
> 完整 payload 已固化在 `scripts/kol_collector.py` 的 `fetch_search_kols()`。本文件只记录**最常需要调整的字段**。

## 常用筛选字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `keyword` | string/null | 搜索关键词（如「探店」「美食」）。不传=不限 |
| `gender` | string | `"不限"` / `"男"` / `"女"` |
| `location` | string[] | 博主地域，**纯城市名** `["上海"]`（实测加 `中国 ` 前缀会削弱过滤）；空数组=不限 |
| `fansLocation` | string[] | 粉丝地域，同 location 纯城市名；空数组=不限 |
| `fansNumberLower` / `fansNumberUpper` | int | 粉丝量范围（如 10000/50000） |
| `notePriceLower` / `notePriceUpper` | int | 图文报价范围（元） |
| `firstIndustry` / `secondIndustry` | string | 一级/二级行业类目。⚠️ 具体取值需从前端筛选 payload 观察，通常为数字编码或中文名；未知时留空，改用 `keyword` + 详情页 `target_tags`（内容标签）过滤 |
| `tradeType` | string | 交易类型，通常 `"不限"` |
| `pageNum` / `pageSize` | int | 分页（pageSize 常用 20） |
| `brandUserId` | string | 关联品牌时传；个人采集留空 |
| `trackId` | string | 每次请求必须更新，`kolMatch_{uuid4hex}` |

## 如何获取某个筛选项的真实取值（如「美食」类目编码）

当 `firstIndustry` 取值不确定时，按以下方法在前端确认：

1. 用 `page.evaluate` 在蒲公英博主广场页执行：点击页面上「美食」类目筛选项
2. 通过 `page.on("response")` 捕获 search API 的请求体（`request.post_data`）
3. 读取 `firstIndustry` / `secondIndustry` 的真实值，回填到 config JSON

```python
def probe_search_payload(main_page):
    captured = {}
    def on_req(req):
        if "cooperator/blogger/v2" in req.url and req.method == "POST":
            captured["body"] = req.post_data
    main_page.on("request", on_req)
    # 让用户/Agent 在页面上点一次「美食」筛选后，打印 captured["body"]
    return captured
```

> 经验：蒲公英的行业枚举通常包含中文一级类目（如「美食」「母婴」「美妆」），但也不排除是数字编码。**先用 keyword + 内容标签过滤是最稳妥路径**，`firstIndustry` 只在确认后可加。

## 其它关键 API（详情页阶段，采集器已自动监听）

| API | 用途 |
|-----|------|
| `GET /api/solar/cooperator/user/blogger/{userId}` | 博主基础信息（名称/地域/粉丝量/报价/标签） |
| `GET /api/solar/kol/data/{userId}/fans_profile` | 粉丝画像（性别占比/城市 Top5） |
| `GET /api/solar/kol/data_v3/notes_rate?userId=..&business=0/1&advertiseSwitch=0/1` | 日常/合作笔记表现中位数；`advertiseSwitch=0` 即「仅自然流量」 |
| `GET /api/solar/kol/data_v2/notes_detail?userId=..&pageNum=..` | 笔记案例列表（含 isAdvertise、曝光/阅读/点赞） |
| `GET /api/solar/kol/data_v2/kol_content_tags` | 内容标签 |
| `GET /api/solar/kol/data_v2/kol_feature_tags` | 擅长标签 |
