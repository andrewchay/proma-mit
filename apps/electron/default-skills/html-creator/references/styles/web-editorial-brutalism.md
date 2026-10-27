# 媒体级粗野主义 Editorial Brutalism（巨号Helvetica压小正文）
> 用户展示名：深色 · 黑底红白报纸头条页
> 静态呈现限制：禁止跑马灯、自动轮播、自动滚动内容条和循环滚动展示。


> 网页 · 大胆派 `大胆·还原98%`

- 参考:Bloomberg Businessweek（Richard Turley 2010-2014 改版，Code and Theory操刀）；Neue Haas Grotesk谱系
- 适配:媒体/内容出版、AI产品发布、品牌官网hero、调研报告封面、观点型长文头图
- 视觉DNA:配色深黑#000为首屏与主阅读基底+纯白#FFF文字/信息块+信号红#FF433D关键标记，超链接蓝#0000EE仅用于链接。字体Helvetica/Neue Haas Grotesk，120px+巨号headline左对齐紧字距直接压住14px小正文，极端字号反差。布局模块化网格+1px规则线分栏切割，高信息密度刻意不留白。标志元素：黑底红白头条、rule line分栏、超链接蓝下划线。
- HTML实现:Tailwind utility + 少量 CSS可1:1还原。Tailwind Grid utilities做模块网格+border做规则线分栏，clamp()做超大响应式字号+letter-spacing收紧，系统Helvetica/Arial栈或Inter兜底，超链接直接#0000EE下划线。零素材依赖。
- 字体映射：默认使用系统字体栈实现。参考气质：Inter（替Helvetica/Neue Haas Grotesk），代码用Geist Mono
