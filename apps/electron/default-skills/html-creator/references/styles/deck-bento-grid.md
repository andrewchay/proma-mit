# Bento便当格模块网格 / Bento Grid
> 用户展示名：浅色 · 品牌色点缀的卡片概览 PPT
> 静态呈现限制：禁止跑马灯、自动轮播、自动滚动内容条和循环滚动展示。


> 演示 deck · 中性派 `中性·还原95%`

- 参考:Apple Keynote Bento Grid时代、新一代MBB Bento/Big-Type deck(2024-2026)、Stripe年报指标卡矩阵、Pitch.com QBR模板
- 适配:产品功能汇总、咨询/QBR数据汇报、销售成果页、town hall指标页
- 视觉DNA:配色=浅灰/奶白底(#F5F5F7/cream)或近黑底+品牌主色+1-2强调色，卡片浅色分区底+圆角+微描边/微阴影。字体=超大display标题+常规正文，字重对比强烈，KPI数字tabular figures。母版=①标题页巨型单句+留白②bento页2×2/3列不等高卡片每卡一洞见(数字/线性icon/sparkline)③one-insight超大数字页。标志=不等高卡片网格、圆角微描边、呼吸感
- HTML实现:Tailwind Grid utilities的grid-template-areas做不等高bento；卡片border-radius+box-shadow微阴影+1px hairline；有数值的 sparkline 用 Chart.js；线性icon用inline SVG stroke。零贴图
- 字体映射：默认使用系统字体栈实现。参考气质：Inter / Geist + 数字Geist Mono
