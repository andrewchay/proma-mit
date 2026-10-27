# 新瑞士大字报 / Neo-Swiss Billboard Editorial
> 用户展示名：浅色 · 蓝白网格大字发布会
> 静态呈现限制：禁止跑马灯、自动轮播、自动滚动内容条和循环滚动展示。


> 演示 deck · 大胆派 `大胆·还原98%`

- 参考:Scribe $75M、Flock Safety $47M 等 AI/SaaS 路演 deck 的 Big-Number Editorial 流派；Bloomberg Businessweek 信息图；Pentagram
- 适配:融资路演、QBR/业务回顾、年度趋势复盘、产品发布关键页
- 视觉DNA:配色=纯白#FFFFFF为首屏与大部分页面基底+电光蓝#2D5BFF主色+中性网格线#E5E5E5，黑#0A0A0A只用于文字和少量结论块。字体=超大粗体无衬线，标题占半屏，数字tabular-nums等宽收紧字距。母版=①蓝白网格章节页一个词②巨型数字占半屏(3.2x)+小注③左右分栏对比④全幅扁平折线/柱状。标志=billboarding大字、严格蓝白基线网格、大色块章节页
- HTML实现:超大数字用clamp()；严格网格用Tailwind Grid utilities；大色块章节页background-color；折线和柱状数值图用 Chart.js canvas（保留清晰标签与单色强调）；数字对齐font-variant-numeric:tabular-nums。零插画零3D
- 字体映射：默认使用系统字体栈实现。参考气质：Inter / Geist / Söhne替代Neue Haas Grotesk；数字配Geist Mono
