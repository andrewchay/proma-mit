---
name: svg-overlay-alignment-on-percent-tracks
description: |
  本仓库（Gravitas/Proma）甘特图/时间轴类 SVG 覆盖层与百分比定位时间条对齐的三个坑。
  Use when: (1) 用 absolute 定位 svg 覆盖在 flex 行列表上画依赖连线/标注，(2) svg 元素
  只给了 left/right 或只给了 width="100%" 却发现图形挤在窄带或偏移一列，(3) viewBox
  百分比坐标与 DOM 内百分比 left/width 条形对不齐，(4) 行列表用 space-y-* 时覆盖层
  纵向中心错位几像素。三条实测验证过的规则：①absolute 同时给 left+right 不给显式
  width 时 right 被忽略、宽度回落 SVG 固有 100px（over-constrained），必须显式
  style width: calc(100% - 偏移)；②width="100%" 解析为定位父级全宽而非轨道列宽，
  需扣除标签列；③space-y-* 是行下方 margin，行内条形中心 = index*rowStep +
  rowHeight/2，不是 rowStep/2。
author: Claude Code
version: 1.0.0
date: 2026-09-16
---

# SVG 覆盖层与百分比时间条对齐三坑

## Problem

在甘特图（左标签列 + 右时间条轨道列，条形用百分比 left/width 定位）上叠 SVG
画依赖连线时，连线端点与时间条头/尾系统性错位。三个独立缺陷叠加，任何一个都会
让「连线悬空」：

1. **横向缩放失效**：`<svg className="absolute inset-y-0 left-[217px] right-0">`
   没有 width —— 绝对定位 over-constrained（left+right 同时指定而 width:auto）
   时 `right` 被忽略，SVG 宽度回落到**固有宽度 100px**，viewBox 0-100 被压进
   100px 窄带，所有图形挤在轨道最左端。
2. **横向偏移一列**：`width="100%"` 解析为**定位父级全宽**（标签列 + gap + 轨道），
   而条形百分比是相对轨道列算的 → 图形整体向左偏移标签列宽度且被横向拉伸。
3. **纵向错位半行**：行列表用 `space-y-2`（行**下方** margin），行内条形
   `absolute top-1 h-4` → 条中心 y = `index*32 + 12`，直觉公式 `index*32 + 16`
   每行偏低 4px。

## Context / Trigger Conditions

- 甘特/时间轴组件：行 = 固定宽标签列 + `flex-1` 轨道列，条形用百分比定位
- SVG 覆盖层用 viewBox（如 `0 0 100 N`）+ `preserveAspectRatio="none"` 映射百分比坐标
- 症状：连线/标注悬空、挤在窄带、或整体偏移一个标签列宽、或纵向差几像素

## Solution

**横向（x 用百分比数值时）**——让 SVG 恰好覆盖轨道列：

```tsx
{/* 定位父级 = 行列表 wrap；left = 标签列宽 + gap */}
<svg
  className="pointer-events-none absolute inset-y-0 left-[217px] right-0"
  style={{ width: 'calc(100% - 217px)' }}   // ① 显式宽度，防 100px 固有回落
  height={rows * ROW_STEP}
  viewBox={`0 0 100 ${rows * ROW_STEP}`}
  preserveAspectRatio="none"
>
```

`calc(100% - 217px)` 中 100% = 定位父级宽，减去标签列 + gap 即轨道列宽。
替代方案：外套一层 `absolute inset-y-0 left-[217px] right-0` 的 div，svg 用
`width="100%" height="100%"`（div 的 100% 就是轨道宽）。

**纵向（y 用像素时）**——行中心公式匹配 space-y 语义：

```ts
// space-y-* 给后续兄弟加 margin-top：第 i 行占 [i*step, i*step+rowH)
// 条 absolute top-(k) h-(h)：中心 = i*step + topOffset + h/2
const centerY = (index: number) => index * rowStep + 12  // top-1(4px) + h-4(16px)/2
```

**坐标同源**：连线端点的百分比必须与行渲染条形的 left/width 用同一公式（提取成
`taskSpanById` Map 复用），避免两处公式漂移。

**方向语义**：依赖边 `dep.taskId`（后置）/`dep.dependsOnTaskId`（前置）极易接反——
markerEnd 在 path 终点（to 端），箭头应指向后置任务。为方向绑定补回归测试
（纯几何测试挡不住语义反转）。

## Verification

用真实浏览器 DevTools 量（推演靠不住）：容器 900px、标签 205px、gap 12px 时，
轨道 = 657px；svg `getBoundingClientRect()` 应为 left=230（容器 padding+标签+gap）、
width=657。任一不符即对应上述三坑之一。

## Example

本仓 `project-flow-metrics.ts` 的 `ganttDependencyPath`（y 契约）+
`ProjectView.tsx` GanttView 的 svg 覆盖层（x 契约）。修复过程：
`8ad4e7f1`（初版）→ `eec8e922`（修 ②纵向）→ `453a69f3`（修 ①③横向 + 方向）。

## Notes

- `vectorEffect="non-scaling-stroke"` 只保线宽不保 marker，`preserveAspectRatio="none"`
  下箭头会随纵横比拉伸——视觉可接受就接受，别为此引入 DOM 测量。
- `minHeight = rows*32` 比 space-y 实际内容高（32n-8）多 8px（最后一行无下方
  margin）；viewBox 高度保留 32n 无妨（路径 y 最大 32n-20，够不到边缘）。
- 纯几何测试（端点 x/y 断言）挡不住 from/to 语义接反，方向绑定要单独一条
  语义测试。

## References

- MDN: Absolutely positioned boxes 的 over-constrained 规则 — https://developer.mozilla.org/docs/Web/CSS/CSS_positioned_layout/Understanding_z-index
- MDN: SVG preserveAspectRatio — https://developer.mozilla.org/docs/Web/SVG/Attribute/preserveAspectRatio
