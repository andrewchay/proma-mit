/**
 * OpenDesign 设计上下文注入（P1）
 *
 * 移植 OD（nexu-io/open-design）的语义：Skill 通过 SKILL.md frontmatter 的
 * `od:` 扩展声明两类可选上下文——
 *
 * - `od.craft.requires: [typography, color, ...]`
 *   按节注入通用工艺规则（design-craft Skill 的 references/<slug>.md）。
 *   craft 规则是品牌无关的「怎么用」：在品牌 DESIGN.md 之上生效；令牌取值
 *   冲突时品牌获胜，品牌未覆盖的规则（字距、强调色用量上限、反 AI 味）仍然适用。
 * - `od.design_system.requires: true`
 *   注入当前激活设计系统的 DESIGN.md（权威令牌契约）与同级 tokens.css
 *   （机器可读契约，要求 verbatim 粘贴进产物首个 <style> 块）。
 *
 * 注入顺序对齐 OD prompt 组装：设计系统正文 → tokens.css → craft 各节。
 * craft 节缺失时保留可用内容，并明确提示所声明的缺项。
 *
 * cwd 根目录已有 `DESIGN.md` 或 `tokens.css` 时优先使用用户文件；
 * 否则可回退到 Owner 工作区里用户确认安装且摘要有效的 OpenDesign 参考。
 *
 * 组合结果由三个 runtime 消费：
 * - AI SDK：ReadSkill 读取 SKILL.md 时追加到工具结果（激活点精确注入）
 * - Pi：preparePromptWithPromaSkills 展开 Skill 正文时前置注入
 * - Claude SDK：agent-prompt-builder 构建动态上下文时按启用 Skill 静态注入
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentWorkspacePath } from './config-paths'
import { readInstalledOpenDesign, readInstalledOpenDesignFromSession } from './opendesign-install-store'

/** 单个 Skill 的 od: 需求声明 */
export interface OdSkillRequirements {
  /** od.craft.requires 中列出的 craft 节 slug（小写、去重、保序） */
  craftRequires: string[]
  /** od.design_system.requires === true */
  designSystemRequires: boolean
}

/** 解析结果上下文（全部字段可为空；空对象表示无需注入） */
export interface OdDesignContext {
  /** 激活设计系统标题（DESIGN.md 首个一级标题或系统 id） */
  designSystemTitle?: string
  /** DESIGN.md 正文 */
  designSystemBody?: string
  /** tokens.css 原文 */
  designSystemTokensCss?: string
  /** 实际解析到的 craft 节 slug（缺失文件已跳过） */
  craftSections: string[]
  /** craft 各节拼接正文（### slug 标头 + --- 分隔） */
  craftBody: string
}

/** craft 节 slug 约束（与 OD SLUG_RE 一致） */
const CRAFT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

/** 归一化 craft slug 列表：小写、合法字符校验、去重、保序 */
function normalizeCraftSlugs(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const slug = value.trim().toLowerCase()
    if (!CRAFT_SLUG_RE.test(slug) || seen.has(slug)) continue
    seen.add(slug)
    out.push(slug)
  }
  return out
}

/**
 * 从 SKILL.md 内容解析 od: 块的需求声明
 *
 * 支持的 YAML 子集（与 OD 现有 skill 的实际写法对齐）：
 * - 内联数组：`requires: [typography, color]`
 * - 列表形式：
 *   `requires:` 后跟 `  - typography` 行
 * - 布尔：`requires: true`
 *
 * 缩进锚定：od: 顶层块（无缩进），其下 craft:/design_system: 缩进 2，
 * requires: 再缩进 2；不满足锚定的行不采集。
 */
export function parseOdRequirements(skillMdContent: string): OdSkillRequirements {
  const result: OdSkillRequirements = { craftRequires: [], designSystemRequires: false }

  const fm = skillMdContent.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fm?.[1]) return result

  const lines = fm[1].split('\n')

  // 定位顶层 od: 块的行区间
  const odIdx = lines.findIndex((l) => /^od:\s*$/.test(l))
  if (odIdx === -1) return result

  let craftRequiresRaw: unknown = []
  let designSystemRaw: string | undefined

  for (let i = odIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    // 空行跳过；回到顶层（无缩进非空行）即 od: 块结束
    if (!line.trim()) continue
    if (!/^\s/.test(line)) break

    // od: 下的一级子键（缩进 2）
    const craftMatch = line.match(/^\s{2}craft:\s*$/)
    const dsMatch = line.match(/^\s{2}design_system:\s*$/)
    if (craftMatch || dsMatch) {
      // 子块内部：向后收集其 requires 值
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j]
        if (!sub?.trim()) continue
        // 回到 od: 一级子键或 od: 块外（缩进 <= 2 的非空行）则子块结束
        if (!/^\s{4}/.test(sub)) { i = j - 1; break }

        const reqInline = sub.match(/^\s{4}requires:\s*\[(.*)\]\s*$/)
        const reqList = sub.match(/^\s{4}requires:\s*$/)
        const reqBool = sub.match(/^\s{4}requires:\s*(true|false)\s*$/)
        if (reqInline) {
          const items = (reqInline[1] ?? '')
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean)
          if (craftMatch) craftRequiresRaw = items
          else if (items.includes('true')) designSystemRaw = 'true'
        } else if (reqList) {
          const items: string[] = []
          let k = j + 1
          for (; k < lines.length; k++) {
            const item = lines[k]?.match(/^\s{6}-\s*(.+)$/)
            if (!item?.[1]) break
            items.push(item[1].trim().replace(/^["']|["']$/g, ''))
          }
          if (craftMatch) craftRequiresRaw = items
          else if (items.includes('true')) designSystemRaw = 'true'
          i = k - 1
        } else if (reqBool && dsMatch) {
          designSystemRaw = reqBool[1]
        }
      }
      continue
    }
  }

  result.craftRequires = normalizeCraftSlugs(craftRequiresRaw)
  result.designSystemRequires = designSystemRaw === 'true'
  return result
}

/**
 * 解析 craft 参考目录：workspace 副本 → 用户 default-skills 种子副本 →
 * app bundle 内置副本。都缺失时返回 undefined（注入静默降级）。
 */
export function resolveDesignCraftDir(opts: {
  workspaceSlug?: string
  getWorkspaceSkillsDir?: (slug: string) => string
  getDefaultSkillsDir: () => string
  getBundledSkillsDir?: () => string
}): string | undefined {
  const candidates: string[] = []
  if (opts.workspaceSlug && opts.getWorkspaceSkillsDir) {
    candidates.push(join(opts.getWorkspaceSkillsDir(opts.workspaceSlug), 'design-craft', 'references'))
  }
  try {
    candidates.push(join(opts.getDefaultSkillsDir(), 'design-craft', 'references'))
  } catch { /* 用户目录不可用时忽略 */ }
  if (opts.getBundledSkillsDir) {
    try { candidates.push(join(opts.getBundledSkillsDir(), 'design-craft', 'references')) } catch { /* 忽略 */ }
  }

  for (const dir of candidates) {
    if (existsSync(join(dir, 'typography.md')) || existsSync(join(dir, 'color.md'))) return dir
  }
  return undefined
}

/** craft 节加载：每节 `### <slug>` 标头，节间 `---` 分隔；缺失/空文件静默跳过（OD 同款） */
export function loadCraftSections(craftDir: string | undefined, requested: readonly string[]): { body: string; sections: string[] } {
  if (!craftDir || requested.length === 0) return { body: '', sections: [] }
  const seen = new Set<string>()
  const parts: string[] = []
  const sections: string[] = []
  for (const raw of requested) {
    const slug = raw.trim().toLowerCase()
    if (!CRAFT_SLUG_RE.test(slug) || seen.has(slug)) continue
    seen.add(slug)
    try {
      const filePath = join(craftDir, `${slug}.md`)
      if (!existsSync(filePath)) continue
      const text = readFileSync(filePath, 'utf-8').trim()
      if (!text) continue
      parts.push(`### ${slug}\n\n${text}`)
      sections.push(slug)
    } catch {
      // 读取失败静默跳过——skill 允许前向引用尚未存在的 craft 节
    }
  }
  return { body: parts.join('\n\n---\n\n'), sections }
}

export interface ActiveDesignSystem {
  title: string
  body: string
  tokensCss?: string
  origin?: string
}

/**
 * 解析 cwd 本地设计系统、会话目录安装或用户确认的 Owner 工作区安装。
 *
 * 优先级：cwd 下用户自己的 DESIGN.md/tokens.css → 本会话目录的 OpenDesign 安装
 * （可能是另存名，按 manifest 读取）→ Owner 工作区共享安装。都不存在时返回
 * undefined（调用方不注入，保持零开销）。
 */
export function resolveActiveDesignSystem(cwd: string | undefined, workspaceSlug?: string): ActiveDesignSystem | undefined {
  const designMdPath = cwd ? join(cwd, 'DESIGN.md') : ''
  const tokensPath = cwd ? join(cwd, 'tokens.css') : ''
  // 会话目录安装：文件名可能是另存名，只能按 manifest 读，不能靠固定文件名探测。
  const sessionInstall = cwd ? readInstalledOpenDesignFromSession(cwd) : undefined
  const installedNames = new Set(sessionInstall ? [sessionInstall.designFile, sessionInstall.tokensFile] : [])
  // 本地文件指「不是本会话安装记录里的那些文件」：否则安装写入的 tokens.css 会把自己挡掉。
  const hasLocalDesign = Boolean(cwd && (
    (existsSync(designMdPath) && !installedNames.has('DESIGN.md'))
    || (existsSync(tokensPath) && !installedNames.has('tokens.css'))
  ))
  if (sessionInstall && !hasLocalDesign) {
    return {
      title: sessionInstall.brandName,
      body: sessionInstall.design,
      tokensCss: sessionInstall.tokens,
      origin: `OpenDesign ${sessionInstall.brandId} ${sessionInstall.referenceRevision}（会话目录 ${sessionInstall.designFile}）`,
    }
  }
  if (!hasLocalDesign && workspaceSlug) {
    try {
      const installed = readInstalledOpenDesign(join(getAgentWorkspacePath(workspaceSlug), 'workspace-files'), workspaceSlug)
      if (installed) return {
        title: installed.brandName,
        body: installed.design,
        tokensCss: installed.tokens,
        origin: `OpenDesign ${installed.brandId} ${installed.referenceRevision}`,
      }
    } catch { /* 安装目录读取失败时不降级成可信资源 */ }
  }
  if (!cwd || !existsSync(designMdPath)) return undefined

  let body: string
  try {
    body = readFileSync(designMdPath, 'utf-8').trim()
  } catch {
    return undefined
  }
  if (!body) return undefined

  // 标题取首个一级标题；没有则用 DESIGN.md 字面名
  const titleMatch = body.match(/^#\s+(.+)$/m)
  const title = titleMatch?.[1]?.trim() || 'DESIGN.md'

  let tokensCss: string | undefined
  if (existsSync(tokensPath)) {
    try {
      const text = readFileSync(tokensPath, 'utf-8').trim()
      if (text) tokensCss = text
    } catch { /* tokens 缺失不阻塞 DESIGN.md 注入 */ }
  }

  return { title, body, tokensCss }
}

/** 组合参数 */
export interface ComposeOdDesignContextInput {
  /** Skill 的 od: 需求（调用方先经 parseOdRequirements 得到） */
  requirements: OdSkillRequirements
  /** craft 参考目录（resolveDesignCraftDir 的结果；undefined 时报告所需资料缺失） */
  craftDir?: string
  /** 工作区 cwd（激活设计系统探测根） */
  cwd?: string
  /** Owner 绑定工作区的稳定身份；用于读取用户明确安装的 OpenDesign 参考。 */
  workspaceSlug?: string
  /** 传入 true 时跳过设计系统探测（cwd 不可用或调用方已判定） */
  skipDesignSystem?: boolean
}

/**
 * 组合 od: 上下文注入块（对齐 OD system.ts 的顺序与关键契约文案）：
 * Active design system → Active design system tokens → Active craft references。
 * 无任何内容时返回空字符串。
 */
export function composeOdDesignContext(input: ComposeOdDesignContextInput): string {
  const { requirements, craftDir, cwd, skipDesignSystem } = input
  const parts: string[] = []

  if (requirements.designSystemRequires && !skipDesignSystem) {
    const ds = resolveActiveDesignSystem(cwd, input.workspaceSlug)
    if (ds) {
      parts.push(
        [
          `<od_design_system source="${escapeAttr(ds.title)}"${ds.origin ? ` origin="${escapeAttr(ds.origin)}"` : ''}>`,
          'Treat the following DESIGN.md as authoritative for color, typography, spacing, and component rules. Do not invent tokens outside this palette.',
          '',
          ds.body,
          ds.tokensCss
            ? [
                '',
                'The block below is this brand\'s tokens.css contract — paste the unscoped `:root { ... }` block verbatim into the artifact\'s first `<style>` so every `var(--*)` reference resolves at runtime. Do not invent new tokens. Do not redefine these values.',
                '',
                '```css',
                ds.tokensCss,
                '```',
              ].join('\n')
            : '',
          '</od_design_system>',
        ].filter(Boolean).join('\n'),
      )
      if (!ds.tokensCss) {
        parts.push('<od_missing_resource type="design_tokens">工作区缺少可用的 tokens.css；请向用户说明设计令牌不可用，不要声称已遵循完整令牌规范。</od_missing_resource>')
      }
    } else {
      parts.push('<od_missing_resource type="design_system">当前任务要求设计系统，但工作区缺少可用的 DESIGN.md；请向用户说明缺项，不要声称成果符合品牌规范。</od_missing_resource>')
    }
  }

  if (requirements.craftRequires.length > 0) {
    const { body, sections } = loadCraftSections(craftDir, requirements.craftRequires)
    if (body) {
      const sectionLabel = sections.length > 0 ? ` — ${sections.join(', ')}` : ''
      parts.push(
        [
          `<od_craft sections="${escapeAttr(sections.join(','))}">`,
          `## Active craft references${sectionLabel}`,
          '',
          'The following craft rules are universal — they apply on top of the active design system (if any), regardless of brand. The DESIGN.md decides *which* tokens to use; craft rules decide *how* to use them. On any conflict between a craft rule and a brand DESIGN.md, the brand wins for token values; craft rules still apply to anything the brand does not override.',
          '',
          body,
          '</od_craft>',
        ].join('\n'),
      )
    }
    const missing = normalizeCraftSlugs(requirements.craftRequires).filter(slug => !sections.includes(slug))
    if (missing.length) {
      parts.push(`<od_missing_resource type="craft" sections="${escapeAttr(missing.join(','))}">当前任务要求的工艺参考缺失：${missing.join('、')}；请向用户说明缺项，不要声称已遵循缺失的参考。</od_missing_resource>`)
    }
  }

  return parts.join('\n\n')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
