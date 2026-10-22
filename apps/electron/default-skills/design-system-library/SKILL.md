---
name: design-system-library
version: 1.0.1
description: "按需获取 152 个品牌设计系统包（Stripe、Linear、Notion、Apple、Airbnb、Vercel 等），含 DESIGN.md 设计规范与 tokens.css 设计令牌。当用户要求「按某品牌风格设计」「像 Stripe/Linear/Notion 那样的视觉」「套用某品牌设计系统」时使用；配合 frontend-design、taste-skill 等设计类 Skill。"
---

# Design System Library · 设计系统按需获取

收录 OpenDesign 上游的 152 个品牌设计系统索引（见 `references/index.md`）。每个系统是一个包含设计规范散文、设计令牌与组件清单的包。

**为什么按需获取**：全量内容约 38MB，不适合随应用打包。Gravitas 通过「用的时候再取」的方式使用它们。

## 系统包的构成

以 stripe 为例，每个系统目录包含：

| 文件 | 作用 | 是否必读 |
| --- | --- | --- |
| `DESIGN.md` | 视觉主题、色彩体系、字体策略、阴影、反模式（核心规范散文） | 必读 |
| `tokens.css` | CSS 变量形式的设计令牌（`--accent`、`--hds-*` 等） | 必用（贴进产物首个 `<style>` 块） |
| `USAGE.md` | 使用顺序与 Do/Don't | 建议读 |
| `components.manifest.json` | 组件清单（紧凑索引） | 需要精确组件结构时读 |
| `tailwind-v4.css` | Tailwind v4 主题变量 | 用 Tailwind 时读 |

## 获取方式（二选一）

### 方式 A：从 GitHub raw 拉取（推荐，无需本地克隆）

对 `<system-id>`，按需读取：

```text
https://raw.githubusercontent.com/nexu-io/open-design/main/design-systems/<system-id>/DESIGN.md
https://raw.githubusercontent.com/nexu-io/open-design/main/design-systems/<system-id>/tokens.css
```

用 WebFetch 读取后即可使用；tokens.css 内容直接作为 CSS 变量注入产物。如需其他文件，把路径替换为 `USAGE.md` / `components.manifest.json` / `tailwind-v4.css`。

### 方式 B：用户本地有 open-design 克隆

若用户本机存在 `open-design` 仓库克隆（如 `~/LLM/open-design`），直接从本地文件系统读取 `design-systems/<system-id>/` 下的对应文件，无需网络。先用文件工具确认路径存在再读取。

## 使用流程

1. 从 `references/index.md` 确认目标系统存在，记下其 `id`。
2. 按方式 A 或 B 取回 `DESIGN.md` 与 `tokens.css`（需要 Tailwind 时加 `tailwind-v4.css`）。
3. **保存到工作区 cwd 根目录**：`DESIGN.md`（必需）与 `tokens.css`（可选）存为工作目录下的同名文件。启用中的设计类 Skill 若声明了 `od.design_system.requires`，这两个文件会被自动注入系统上下文（Active design system / tokens 契约块），无需再手动粘贴。
4. 阅读 `DESIGN.md` 的视觉主题与反模式约定，把 `tokens.css` 的变量用于产物的首个 `<style>` 块，再按规范实现组件。
5. 保持令牌变量名原样（`--accent` 等），保证跨品牌切换可靠；主操作、链接、聚焦态统一用 `--accent`，并保持一个清晰的视觉焦点。
6. 结合 `design-craft` Skill 的工艺规则（反 AI 味、排版、色彩）打磨细节。

## 注意事项

- 品牌名与 logo 属于各自所有者；令牌与文字规范用于风格参考，产物中不得复制受保护的商标图形资产。
- 上游仓库的目录结构若变化（如 `main` 分支改路径），以 `https://github.com/nexu-io/open-design/tree/main/design-systems` 实际列表为准。
- 引入基线：OpenDesign `e03d5c23f3`（v0.26.1），Apache-2.0。
