# 高饱和单色品牌撞色海报 / Mono-Brand Type-as-Hero
> 用户展示名：深色 · 黑底亮色大字开场 PPT
> 静态呈现限制：禁止跑马灯、自动轮播、自动滚动内容条和循环滚动展示。


> 演示 deck · 大胆派 `大胆·还原96%`

- 参考:Spotify Wrapped视觉系统、Mailchimp Brand Book(Collins)、Netflix红黑现代复刻、COLLINS品牌系统
- 适配:品牌/营销策略、campaign宣讲、town hall文化页、活动主视觉
- 视觉DNA:配色=深黑#0A0A0A为首屏与大部分页面基底+一项高饱和亮色（电光绿#1ED760、明黄#FFE01B或亮红#E50914）承载巨字与关键数字+白色辅助字。字体=超大字体即主视觉(type-as-hero)顶天立地。母版=①黑底亮色巨字②黑底与亮色块的上下/左右分割③巨型亮色数字撑满。标志=黑底亮色、字体当图、强字号反差
- HTML实现:满版深黑background-color；超大亮色字用clamp()占满；需要色块时只用一块亮色与黑底分割；字体当图靠font-weight900+负letter-spacing。纯色块零素材，HTML原生最爽
- 字体映射：默认使用系统字体栈实现。参考气质：Inter / Manrope / Archivo(超粗)替代Circular/Cavendish
