# MindElixir 最小用法

何时使用：仅当内容核心是从一个主题向多层分支展开的静态层级脑图时，加载 MindElixir 的配套 CSS 与脚本；流程、审批、条件分支、依赖网络或精确数量比较不要用脑图。构造器按所选版本和构建格式取得：下例适用于提供 `MindElixir.default` 的全局脚本；采用模块导入时使用对应导出，不假定所有构建都有同一全局对象。

只在内容需要从中心主题向层级分支呈现时使用 MindElixir。适合策略拆解、会议纪要归类、课程框架与知识树；不适合流程、审批、条件分支、依赖网络或精确数量比较。默认使用 `MindElixir.RIGHT`，让根节点从左向右展开，便于嵌入网页正文；只有用户明确要求双侧发散布局时才改方向。

每个节点必须使用稳定唯一的 `id`，文本保持简短；建议控制在 3 层以内，每层约 3–7 个子节点。必须关闭编辑与操作能力：设定 `draggable: false`、`toolBar: false`、`contextMenu: false`、`keypress: false`，初始化后调用 `mind.disableEdit()`，并对画布设置 `pointer-events: none`。容器应设置明确的 `height`、`min-height` 与 `overflow: hidden`，不能让画布靠内容撑开。MindElixir 会在初始化时测量容器宽度；使用运行时注入内容或异步样式时，先确认相关样式、字体和容器尺寸就绪，再构造、`init()` 并在下一帧执行一次 `scaleFit()`；不能把单个事件视为所有加载方式的就绪保证。下例用 `window.load` 等待常规页面资源，若之后仍注入内容或样式，应改用对应的完成信号。若脑图位于 Grid/Flex 子项中，该子项和脑图外层都必须设 `min-width: 0`（Tailwind：`min-w-0`）与 `max-width: 100%`，防止内容反向撑宽列。若 `RIGHT` 模式产生无用的左侧空容器，可只对目标实例加 `#mindmap me-main.lhs { display: none; }`。

**主题按页面需要配置，不套用固定配色。** 只有页面需要与脑图统一品牌色、使用深色画布或默认 Latte 主题不合适时，才传入 `theme`。此时 `theme.palette` 必须是按分支顺序使用的颜色**数组**，不能写成 `{ canvas, root, ... }` 对象；`theme.type` 必须显式匹配页面的 `"light"` 或 `"dark"`。深色页还必须设置 `cssVar['--bgcolor']`，并与页面背景一致；否则会沿用浅色默认画布。主题化脑图还要显式设置 `cssVar['--line-color']` 与 `cssVar['--line-color-selected']`，令普通连线、箭头与选中连线和当前页面的强调色/对比度一致。配色、圆角、节点面板和间距均从当前页面的设计变量推导，不默认添加任何指定颜色或渐变。

**最小脑图案例（假定已加载配套 CSS 和提供 `MindElixir.default` 的全局脚本）：**

```html
<div class="mindmap-shell">
  <div id="mindmap" aria-label="项目策略脑图"></div>
</div>
<style>
  .mindmap-shell { min-width: 0; max-width: 100%; height: 560px; overflow: hidden; }
  #mindmap { width: 100%; min-width: 0; max-width: 100%; height: 100%; overflow: hidden; pointer-events: none; }
</style>
<script>
  const MindElixirClass = MindElixir.default;
  const data = { nodeData: { id: 'root', topic: '项目策略', root: true,
    children: [{ id: 'goal', topic: '目标' }, { id: 'plan', topic: '行动计划' }] },
    arrows: [], summaries: [], direction: MindElixirClass.RIGHT };
  const initMindmap = () => {
    const mind = new MindElixirClass({
      el: '#mindmap', direction: MindElixirClass.RIGHT, draggable: false,
      contextMenu: false, toolBar: false, keypress: false
    });
    mind.init(data);
    mind.disableEdit();
    requestAnimationFrame(() => mind.scaleFit());
  };
  if (document.readyState === 'complete') initMindmap();
  else window.addEventListener('load', initMindmap, { once: true });
</script>
```

需要自定义主题时，通过 MindElixir `theme` 的 `palette` 与 `cssVar` 覆盖根节点、主节点、分支节点、画布、连线和间距，令其服从页面视觉系统；默认主题与页面相配时无需额外覆盖，也不要用过多颜色给同级节点编码无意义差异。若个别版本未将连线变量应用到生成的 SVG，在确认该实例的节点不使用 SVG 路径后，可为该实例追加 CSS 兜底：`#mindmap svg path { stroke: var(--mindmap-line-color) !important; } #mindmap svg marker path { fill: var(--mindmap-line-color) !important; }`；先在 `#mindmap` 上把 `--mindmap-line-color` 设为从页面主题推导的颜色，且不要将这条规则泄漏到其他 SVG 图表。
