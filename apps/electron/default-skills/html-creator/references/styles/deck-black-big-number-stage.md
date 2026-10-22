# 黑底巨型数字剧场 / Black Big-Number Stage
> 用户展示名：深色 · 黑底大数字发布会
> 静态呈现限制：禁止跑马灯、自动轮播、自动滚动内容条和循环滚动展示。


> 演示 deck · 大胆派 `大胆·还原97%`

- 参考:Steve Jobs 2007 iPhone Keynote、小米SU7 Ultra雷军发布会、Spotify Wrapped、Presentation Zen(Garr Reynolds)
- 适配:产品发布主题演讲、思想演示、全员town hall、情绪向年度回顾
- 视觉DNA:配色=纯黑#000000底+纯白#FFFFFF字高反差，一页只一个品牌强调色高亮(小米橙#FF6900/Spotify绿#1ED760/Apple蓝#2997FF)。字体=几何无衬线粗体，一屏一词或一个超大数字占满视野，字距收紧。母版=①标题页黑底居中一行大字②数据高潮页巨型数字+单位+一行注③左右参数对比双栏(强调色vs灰)④slogan单页。大量负空间
- HTML实现:黑底白字几行CSS；巨型数字clamp()+flex居中；强调色highlight单独span；左右对比Tailwind Grid utilities两列+条形高亮；tabular-nums。去掉产品照改纯文字反而更接近Zen本质
- 字体映射：默认使用系统字体栈实现。参考气质：Geist / Inter / 思源黑替代SF Pro
