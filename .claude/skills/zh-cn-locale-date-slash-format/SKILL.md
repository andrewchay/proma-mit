---
name: zh-cn-locale-date-slash-format
description: |
  本仓库（Gravitas/Proma）渲染层日期展示格式的坑：new Date().toLocaleDateString('zh-CN')
  输出的是「2026/9/20」或带斜杠的「09/20」，不是「09-20」。Use when: (1) 需要 MM-DD 格式的
  日期文案（徽标/列表/tooltip），(2) 单测精确断言日期字符串却实测拿到斜杠，(3) 新写日期展示
  函数时想当然认为 zh-CN 就是横杠分隔。解法：手工 padStart 拼 MM-DD，或 toLocaleDateString
  后 .replace(/\//g, '-')。
author: Claude Code
version: 1.0.0
date: 2026-09-15
---

# zh-CN locale 日期格式是斜杠不是横杠

## Problem

规格/设计文档里写「日期段统一 `MM-DD`」（如 `09-20`），实现时直觉写法是：

```ts
new Date(due).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
```

实测输出是 **`09/20`**（斜杠），与文档、JSDoc 示例、既有 UI 文案全部不一致。
且 `toLocaleDateString` 输出依赖运行环境 ICU 数据，对被单测钉住格式的纯函数引入了不必要的环境依赖。

## Context / Trigger Conditions

- 设计文档/JSDoc 写明 `MM-DD`（横杠），实际 UI 出现 `09/20`
- 测试 `expect(text).toBe('09-20 · 剩 5 天')` 失败，实际值含 `/`
- 新增任何面向用户的日期展示（截止日期徽标、活动时间、甘特 tooltip 等）

## Solution

本仓库既有主流写法是**手工 padStart 拼接**（结果确定、无环境依赖）：

```ts
const due = new Date(timestamp)
const dateText = `${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
```

既有先例：`TodoEventPanel.tsx`、`TokenUsageSettings.tsx`、`GoalsSettings.tsx`、`RunCenterSettings.tsx` 均手工拼接；
`ScheduleView.tsx`、`EventCreatePanel.tsx` 用 locale 时都补了 `.replace(/\//g, '-')`。

## Verification

```bash
bun -e "console.log(new Date(2026,8,20).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}))"
# 输出 09/20 —— 证明 locale 写法不符合 MM-DD 预期
```

改用 padStart 后，单测精确断言 `toBe('09-20 · 剩 5 天')` 通过。

## Example

`project-flow-metrics.ts` 的 `dueDateUrgency()` 曾用 locale 写法，2026-09-15 代码审查发现实际输出
`09/20 · 剩 5 天`（且 JSDoc 声称 `09-20`），已改为 padStart 拼接并加精确断言锁格式。

## Notes

- 配套教训（同一函数审查发现）：守卫非法时间戳要用 `!Number.isFinite(dueDate)` 而非
  `Number.isNaN(dueDate)`——`Infinity` 能通过 NaN 检查，会渲染出 `Invalid Date · 剩 NaN 天`。
- 相关模式：外层条件渲染（如 `task.dueDate !== undefined`）必须与子组件内部 null 语义
  （如 `dueDateUrgency` 的 isDone/非法值判断）对齐，否则已完成任务会渲染空的 8px 容器。

## References

- MDN: Intl.DateTimeFormat 与 locale 数据差异 — https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Date/toLocaleDateString
