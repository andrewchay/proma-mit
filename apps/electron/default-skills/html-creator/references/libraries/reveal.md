# Reveal.js 最小用法

何时使用：仅新建 deck（网页版 PPT / 翻页演示）时需要，同时加载 Reveal CSS 与 JS，使用 `.reveal > .slides > section` 结构并调用 `Reveal.initialize()`；连续滚动网页不得加载。

使用固定画布和语义 section：

```html
<div class="reveal"><div class="slides">
  <section data-background-color="#fffdf9">
    <div class="slide-content">…一个观点…</div>
  </section>
</div></div>
<script>
  Reveal.initialize({
    width: 1440, height: 810, margin: 0.03,
    minScale: 0.3, maxScale: 1.5, center: false,
    controls: true, progress: true, slideNumber: 'c / t',
    hash: true, transition: 'slide', backgroundTransition: 'fade'
  });
</script>
```

每页只讲一个判断。Reveal 用绝对定位搭建舞台，并内联控制每个 `section` 的 `display` 显隐；因此**不要覆盖 section 的 `position`（尤其不要加 `position: relative`）**，也不要依赖 `min-height: 100%` 撑满页高——在 Reveal 的 section 高度计算下它会失效，导致内容顶对齐。统一使用下面的结构：section 保持 Reveal 的定位与显隐控制，只在 `present`/`past`/`future` 状态下作为纵向 flex 容器（必须用 `!important` 压过 Reveal 的内联 `display: block`），让 `.slide-content` 通过 `flex: 1` 撑满整页高度并在内部垂直居中。不要只在首尾页临时套 inline flex：

```css
.reveal .slides { text-align: left; }
.reveal .slides > section {
  box-sizing: border-box;
  height: 100%;
  padding: 0;
}
.reveal .slides > section.present,
.reveal .slides > section.past,
.reveal .slides > section.future {
  display: flex !important;
  flex-direction: column;
}
.reveal .slides > section > .slide-content {
  box-sizing: border-box;
  flex: 1 1 0%;
  min-height: 0;
  padding: 58px 84px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  justify-content: safe center;
}
.reveal .slides > section > .slide-content.slide-content--top {
  justify-content: flex-start;
}
```

三个状态选择器必须同时命中：Reveal 5.2 会给每个 section 写内联 `display: block`，若只把 `.present` 转成 flex，退场页会在转场中把内容从居中弹回顶部；`present`/`past`/`future` 都转 flex 才能让翻页过程稳定。`safe center` 表示内容超高时自动回退为顶部对齐，避免 flex 居中把顶部内容裁出画布；不支持该关键字的旧浏览器会忽略这一行、保留普通居中。

默认让封面、结尾和普通内容页都垂直居中；只有密集表格、长流程或多模块图表页才显式添加 `slide-content--top` 顶对齐。把标题、eyebrow、网格、表格等全部放进 `.slide-content`，不要直接挂在 `section` 下。首尾页可以更强，内容页以信息清晰为先。

## 封面与结尾的背景、选择器和对比度

封面与结尾通常把语义类直接加在 slide 的 `section` 上，例如 `<section class="cover">`、`<section class="end">`。CSS 必须直接命中该元素：使用 `.reveal .slides > section.cover` 和 `.reveal .slides > section.end`；**禁止**写成 `.cover section` 或 `.end section`，后者只会匹配 `.cover` / `.end` 内部的后代 `section`，不会匹配带类的 slide 本身。

```css
.reveal .slides > section.cover,
.reveal .slides > section.end {
  background: var(--navy);
  color: #fff;
}
.reveal .slides > section.cover .eyebrow,
.reveal .slides > section.end .eyebrow {
  color: #b9c8dc;
}
```

为每种封面/结尾配色同时显式声明背景和正文颜色，不要依赖继承或全局默认值。深色背景配浅色正文，浅色背景配深色正文；普通文字对比度至少 4.5:1，封面主标题优先达到 7:1。完成后必须实际检查第 1 页和最后一页，确认类选择器命中、背景已生效、标题和副标题可读。

## Deck 字号下限

Reveal 会缩放 1440×810 画布；在卡片和表格中使用 `text-xs`、`text-sm` 会使文字在预览或投屏时难以阅读。对所有**可见** deck 内容执行下列下限：

- 页面主标题至少 `text-5xl`（48px），章节标题至少 `text-3xl`（30px）。
- 正文、要点和卡片内容至少 `text-xl`（20px）；表格表头与单元格至少 `text-lg`（18px）。
- 标签、图例、编号、时间与来源行至少 `text-base`（16px）。禁止用 `text-xs` 或 `text-sm` 作为可见 deck 内容的默认字号。
- 信息放不下时，优先拆成两页、减少列数或压缩文案；不要缩小字号、减小 `line-height` 或依赖 Reveal 的缩放来硬塞内容。
- 对表格使用更大的单元格内边距和 `leading-relaxed`；表格超过 5–6 行或 4–5 列时，拆页或改为结论 + 单图/列表。

## Deck 行高与留白

只增大字号而沿用紧行高，会让内容页和表格显得拥挤。按内容角色明确设置行高，不要依赖 Tailwind 默认值或从网页组件继承：

- 展示型标题可用 `leading-[1.05]` 到 `leading-tight`；标题之外，禁止使用 `leading-none` 或 `leading-tight`。
- 正文、要点和卡片内容使用 `text-xl leading-relaxed`；多段文字之间保留至少 `mt-3` 或等价段落间距。
- 表格表头与单元格使用 `text-lg leading-[1.5]`，并为单元格保留至少 `px-4 py-3`；多行单元格不得使用紧凑行高。
- 标签、图例、编号和来源行使用 `text-base leading-snug`；它们可以更紧，但不能压缩正文或表格的阅读空间。
- 遇到行数上升时，先增加卡片内边距、表格行高或拆页；不要以负 margin、固定低高度或 `overflow:hidden` 裁掉文字。
