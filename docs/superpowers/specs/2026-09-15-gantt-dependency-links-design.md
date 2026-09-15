# 甘特图依赖连线 — 设计文档

日期：2026-09-15
状态：已确认（方案 A：SVG 连线层，覆盖全部四种依赖类型）

## 背景

甘特视图（`ProjectView.tsx` 的 `GanttView`，约 1612 行）每行渲染任务条，但 `dependencies: TaskDependency[]` 数据（`taskId`/`dependsOnTaskId`/`type`）完全未用于行间连线，仅在头部统计「N 条依赖」。任务之间的前置关系在图上不可见。

## 需求（用户已确认）

- 甘特图上画任务间依赖连线
- 覆盖全部四种类型：finish_to_start / start_to_start / finish_to_finish / start_to_finish

## 设计

### 1. 坐标计算纯函数（`project-flow-metrics.ts`）

```ts
export interface GanttLinkEndpoints {
  from: { index: number; startPct: number; endPct: number }
  to: { index: number; startPct: number; endPct: number }
}

/** 依赖连线路径与颜色语义 */
export interface GanttDependencyPath {
  /** SVG path d 属性 */
  d: string
}

/**
 * 甘特依赖连线：百分比时间轴 × 固定行高网格 → SVG 路径。
 * 行布局契约：每行高 24px（h-6）+ 行距 8px（space-y-2）= 32px 步进；条 top-1 h-4（16px）行内垂直居中。
 * 端点规则：
 *   finish_to_start: from 条尾 → to 条头
 *   start_to_start:  from 条头 → to 条头
 *   finish_to_finish: from 条尾 → to 条尾
 *   start_to_finish:  from 条头 → to 条尾
 * 路径形状：端点水平伸出 6px → 三次贝塞尔跨行 → 水平入对端；同行（index 相同）直接水平直线。
 * x 单位为百分比数值（0-100），y 单位为像素；调用方 SVG 按百分比宽度换算（viewBox 或 preserveAspectRatio 方案由渲染端定，见 §2）。
 */
export function ganttDependencyPath(
  endpoints: GanttLinkEndpoints,
  type: 'finish_to_start' | 'start_to_start' | 'finish_to_finish' | 'start_to_finish',
  rowHeight = 32,
  barHeight = 16,
): GanttDependencyPath
```

行中心 y = `index * rowHeight + (rowHeight - barHeight) / 2 + barHeight / 2`（条垂直中心）。

### 2. 渲染（`GanttView` 内，`ProjectView.tsx`）

- 时间条列（`<div className="relative h-6 flex-1 rounded bg-muted/50">` 的每行父容器）改为：行列表外再包一层 `relative` 容器，行渲染完后叠加 `<svg className="absolute inset-0 pointer-events-none">`
- **坐标系**：SVG 用 `width=100%` + `preserveAspectRatio="none"` + viewBox 宽 100 高 = 行数×32，路径 x 直接用百分比数值、y 用像素 —— 保持与时间条 left/width 百分比同源，免测量 DOM
- 每条 dependency：两端任务 id → `sortedTasks` index 与 left/width（复用行渲染同公式）；任一端不在 `datedTasks` 中则跳过
- 颜色：普通依赖 `stroke-gray-400`、`opacity-60`、1px、`fill=none`；**阻塞生效中的依赖**（`blockers` 中 `taskId` 命中该依赖的 `taskId`）用红色（`stroke-red-500`、不透明）
- 箭头：`<marker>` 定义小三角，画在 to 端
- 头部图例追加：`— 灰 依赖 · — 红 阻塞生效中`

### 3. 测试（BDD，`project-flow-metrics.test.ts` 追加）

1. FS 跨行：from 条尾 x=80、to 条头 x=30，index 0→2，路径含贝塞尔控制点（`C` 指令），终点 x=30
2. SS：起点取 from 条头、终点取 to 条头
3. FF：两端均条尾；SF：from 条头 → to 条尾
4. 同行（index 相同）：路径为水平直线（无 `C` 指令）
5. 默认参数：y 中心 = index×32 + 16

### 错误处理

- 依赖两端任一不在当前甘特任务集（被过滤/无日期）：跳过该线，不渲染、不报错
- 自依赖（taskId === dependsOnTaskId）：跳过

### 不改动

- 数据层、DependencyPanel、看板、任务排序
- 甘特行渲染结构（仅外层加 relative + svg 覆盖层）

## 版本

`@proma/electron` patch +1（提交时递增）。
