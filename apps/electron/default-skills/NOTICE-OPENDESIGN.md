# default-skills 第三方内容来源与许可说明（NOTICE）

本目录中标注为「OpenDesign 设计内容包」的 Skill 引自
[nexu-io/open-design](https://github.com/nexu-io/open-design)（下称 OpenDesign）仓库，
引入基线 commit：`e03d5c23f308c39f4de7c057568df66c29a84385`（v0.26.1）。

OpenDesign 整仓以 Apache License 2.0 发布；其中部分 Skill 附带各自独立的
LICENSE 文件（多为 MIT），已在下方逐项列明。各 Skill 目录内保留的原始
LICENSE/LICENSE.txt/SOURCES.md 文件优先于本说明；本说明仅作汇总索引。

Apache-2.0 授权文本见仓库根目录 `LICENSE-APACHE`。

## OpenDesign 设计内容包含 25 个 Skill

### 随 OpenDesign 仓库以 Apache-2.0 发布（无独立 LICENSE 文件）

- frontend-design（附 Apache-2.0 LICENSE.txt，上游 anthropics/skills）
- impeccable-design-polish、design-brief、motion-design、deck-swiss-international
- card-xiaohongshu、data-report、article-magazine、deck-open-slide-canvas、poster-hero
  （上游 nexu-io/html-anything）
- design-craft（组合 Skill，references 引自 OpenDesign `craft/`；
  其中 anti-ai-slop.md 改编自 referodesign/refero_skill，MIT）
- design-system-library（组合 Skill，仅含获取说明与索引，不含设计系统内容本体）

### MIT 许可（保留独立 LICENSE 文件）

- taste-skill、redesign-skill、minimalist-skill、brutalist-skill、soft-skill、brandkit
  —— Copyright (c) 2026 Leonxlnx（上游 github.com/Leonxlnx/taste-skill；
  taste-skill 在上游 frontmatter 中名为 design-taste-frontend）
- animate、review-animations、emil-design-eng
  —— Copyright (c) 2026 Matt Pocock（上游 github.com/emilkowalski/skills）
- ui-animation —— MIT（上游 github.com/mblode/agent-skills）
- gsap-core、gsap-timeline、gsap-scrolltrigger —— MIT（GSAP 官方技能）

## 导入时的修改

- SKILL.md frontmatter 统一 `name` 等于目录 slug（如 taste-skill 上游名为
  design-taste-frontend），并新增 `version: 1.0.0` 以接入 semver 同步机制。
- 正文内容与 references/assets 原样保留，便于后续按上游 diff 升级。

## 商标与品牌资产提示

design-system-library 仅收录获取说明与系统索引，不随包分发任何品牌设计系统
内容；使用时按需拉取的 tokens/文字规范仅作风格参考。相关品牌名称与 logo
归各自所有者所有，产物中不得复制受保护的商标图形资产。
