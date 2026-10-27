# 产品功能剧场 Product Feature Theatre（单功能单舞台+结果型演示）
> 用户展示名：深色 · 深色产品发布舞台
> 静态呈现限制：禁止跑马灯、自动轮播、自动滚动内容条和循环滚动展示。


> 网页 · 大胆派 `大胆·还原90%`

- 参考:Stripe 产品页 / Nothing 发布页 / Linear feature launch；产品演示被组织成连续的舞台场景
- 适配:软件介绍、功能概览、产品发布、launch overview；适合功能不多但每项需要讲清价值和使用瞬间的产品。
- 视觉DNA:配色骨白#F3F0E8+墨黑#191919+橘红#FF4D2E+酸绿#C6FF00，强调色按功能章节切换。字体粗无衬线主标题×等宽状态字。布局每个功能占一个全幅 section，左侧结论和短文案，右侧真实 UI/抽象演示舞台。标志元素：功能编号、强色产品舞台、结果先于功能名。
- HTML实现:Tailwind Grid + `min-h-screen`，真实截图使用已获授权且可访问的图片资源；无图时以可解释的 CSS/SVG 假界面、数据流或状态卡替代。小屏以“结论→演示→细节”顺序堆叠；可选 CSS 轻动效，reduced motion 下保持静态，不依赖 WebGL。
- 字体映射：默认使用系统字体栈实现。参考气质：Söhne / Inter Display + Geist Mono，映射为 system-ui + ui-monospace。
