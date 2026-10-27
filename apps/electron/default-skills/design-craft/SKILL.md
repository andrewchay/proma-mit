---
name: design-craft
version: 1.0.0
description: "专业 UI 工艺规则库：排版、色彩、动效纪律、无障碍、状态覆盖、表单校验、反 AI 味设计等 11 个维度的通用工艺知识。在执行任何 Web/UI 设计、前端页面、HTML 产物、海报卡片或界面打磨任务时，先读取本 Skill 再按需查阅对应 reference；与 frontend-design、taste-skill 等设计类 Skill 配合使用。"
---

# Design Craft · 专业 UI 工艺规则库

本目录是品牌无关的通用设计工艺知识（源自 OpenDesign craft/，Apache-2.0）。每份 reference 是一个维度的紧凑规则手册。

`DESIGN.md`（或品牌规范）告诉 agent 某个品牌用什么颜色和字体；本 Skill 告诉 agent 优秀设计师在此之上普遍遵守的规则——例如「ALL CAPS 必须加 ≥0.06em 字距」这类与品牌无关的硬约束。

## 使用方式

执行设计任务时**不要一次读完全部参考**。先判断本次任务涉及哪些维度，再只读取对应的 1~3 个文件：

| 任务场景 | 优先读取 |
| --- | --- |
| 任何页面 / UI / HTML 产物的视觉质量把关 | `references/anti-ai-slop.md` |
| 排版层级、字号、字距、行高 | `references/typography.md`、`references/typography-hierarchy.md` |
| 长文阅读页、杂志式排版 | `references/typography-hierarchy-editorial.md` |
| 配色、强调色用量、中性色层次 | `references/color.md` |
| 交互动效、过渡、缓动 | `references/animation-discipline.md` |
| 可点击性、对比度、可访问性底线 | `references/accessibility-baseline.md` |
| 交互状态覆盖（hover/focus/disabled/loading/empty/error） | `references/state-coverage.md` |
| 表单与校验体验 | `references/form-validation.md` |
| 阿拉伯语 / 希伯来语等 RTL 场景 | `references/rtl-and-bidi.md` |
| 经典 UX 法则速查（Fitts、Hick、Miller 等） | `references/laws-of-ux.md` |

## 与其他设计 Skill 的关系

- `frontend-design` / `taste-skill`：负责「选方向、出整体设计」；本 Skill 负责「用专业工艺把细节做对」。
- `impeccable-design-polish` / `review-animations`：打磨阶段可对照本 Skill 的规则逐条自查。
- OD 上游中 `anti-ai-slop.md` 的部分规则由 daemon 的 lint-artifact 自动强制；在 Gravitas 中没有该 linter，P0（必须修复）规则应视为硬性自查项。

## 来源

- 上游：`nexu-io/open-design` 仓库 `craft/` 目录（Apache-2.0），引入基线 commit `e03d5c23f3`。
- `anti-ai-slop.md` 改编自 referodesign/refero_skill（MIT）。
