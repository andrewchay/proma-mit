# Neo-Swiss暗色终端美学 / Dark Hairline Terminal
> 用户展示名：深色 · 黑底技术终端 PPT
> 静态呈现限制：禁止跑马灯、自动轮播、自动滚动内容条和循环滚动展示。


> 演示 deck · 中性派 `中性·还原94%`

- 参考:Linear pitch deck、Vercel设计语言、CS50深黑舞台课件；字体Inter Tight+JetBrains Mono
- 适配:开发者工具/技术产品发布、技术路演、工程向汇报
- 视觉DNA:配色=近黑底(#0D0D0F/#111113)+hairline细线#262629网格+单一紫蓝强调(#5B5BD6/#7C7CFF)。字体=Inter Tight大标题+JetBrains Mono做标签/数据。母版=①极简标题页一句话+mono小标②hairline分隔的数据网格③mono标签的特性列表。标志=1px细线网格、mono单等宽标签、极致留白、近黑非纯黑
- HTML实现:近黑背景+border:1px solid的hairline网格；mono标签用等宽font-family；微光用极淡box-shadow/border highlight而非真光效(降级避开赛博霓虹禁区)。注意避开#0D1117深蓝禁区，用中性近黑
- 字体映射：默认使用系统字体栈实现。参考气质：Inter Tight + JetBrains Mono / IBM Plex Mono
