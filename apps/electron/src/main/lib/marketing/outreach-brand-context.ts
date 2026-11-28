/**
 * 品牌侧固定信息解析。
 *
 * 来源：工作区 `skills/ma-kol-outreach/SKILL.md` 的「一、品牌侧固定信息」小节。
 * 那一节是话术的唯一来源（见该 SKILL.md 开头的约定），
 * 这里只做读取与结构化，不维护第二份。
 *
 * 为什么必须接：不注入这部分，模型不知道品牌名、我方自称、平台、返点口径，
 * 只能写「【待补充：品牌名】」这种占位，草稿等于不能用。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentWorkspacePath } from '../config-paths'

/** 结构化后的品牌侧信息 */
export interface BrandContext {
  brandName: string
  selfTitle: string
  storeOrRegion: string
  platform: string
  /** 返点口径原文（内部掌握，禁止对达人说出数字） */
  rebatePolicy: string
  /** 是否已完成配置（有未替换的 [方括号] 占位则为 false） */
  configured: boolean
}

/** 提取「一、品牌侧固定信息」小节的正文 */
function extractBrandSection(markdown: string): string | null {
  // 匹配 `## 一、品牌侧固定信息` 到下一个 `## ` 之间
  const match = markdown.match(/^##\s*一、?\s*品牌侧固定信息[\s\S]*?(?=^##\s)/m)
  return match ? match[0] : null
}

/** 从一行里取 `- 键：值` 的值 */
function pickValue(section: string, ...keys: string[]): string {
  for (const key of keys) {
    // 支持 `- 品牌名：xxx` / `- **品牌名**：xxx`
    const re = new RegExp(`^\\s*-\\s*\\**${key}\\**\\s*[：:]\\s*(.+?)\\s*$`, 'm')
    const m = section.match(re)
    if (m?.[1]) {
      return m[1].replace(/^`|`$/g, '').trim()
    }
  }
  return ''
}

/** 判断值是否仍是未替换的占位（如 `[品牌名]`） */
function isPlaceholder(value: string): boolean {
  return !value || /^\[.*\]$/.test(value.trim()) || value.includes('[品牌名]')
}

/**
 * 读取指定工作区的品牌侧信息。
 *
 * @param workspaceSlug 工作区 slug
 * @returns 解析结果；文件不存在或未配置时 configured=false
 */
export function readBrandContext(workspaceSlug: string): BrandContext {
  const empty: BrandContext = {
    brandName: '',
    selfTitle: '',
    storeOrRegion: '',
    platform: '',
    rebatePolicy: '',
    configured: false,
  }

  try {
    const skillPath = join(
      getAgentWorkspacePath(workspaceSlug),
      'skills',
      'ma-kol-outreach',
      'SKILL.md',
    )
    if (!existsSync(skillPath)) return empty

    const markdown = readFileSync(skillPath, 'utf-8')
    const section = extractBrandSection(markdown)
    if (!section) return empty

    const brandName = pickValue(section, '品牌名')
    const selfTitle = pickValue(section, '我方自称')
    // 「投放门店 / 区域：xxx ｜ 平台：xxx」在同一行
    const storeLine = pickValue(section, '投放门店\\s*/\\s*区域', '投放门店')
    const platformInLine = storeLine.match(/平台\s*[：:]\s*([^｜|]+)/)?.[1]?.trim() ?? ''
    const storeOrRegion = storeLine.split(/[｜|]/)[0]?.replace(/平台\s*[：:].*$/, '').trim() ?? ''

    // 返点口径可能有多行，取整段
    const rebateMatch = section.match(/返点口径[^\n]*\n((?:\s{2,}[-*].*\n?)*)/)
    const rebatePolicy = rebateMatch?.[1]?.trim() ?? ''

    return {
      brandName,
      selfTitle,
      storeOrRegion,
      platform: platformInLine,
      rebatePolicy,
      configured: !isPlaceholder(brandName),
    }
  } catch {
    // 读取失败不阻断草稿生成，只是没拿到品牌信息
    return empty
  }
}

/**
 * 把品牌侧信息渲染成给模型看的文本。
 *
 * 未配置时明确告诉模型「信息缺失，用占位标出」，
 * 避免模型自行编造品牌名或价格。
 */
export function formatBrandContext(ctx: BrandContext): string {
  if (!ctx.configured) {
    return [
      '品牌侧信息尚未配置。',
      '请在草稿中用【待补充：xxx】标出所有需要品牌信息的位置，**不要编造**。',
    ].join('\n')
  }

  const lines = [
    `品牌名：${ctx.brandName}`,
    ctx.selfTitle ? `我方自称：${ctx.selfTitle}` : '',
    ctx.storeOrRegion ? `投放门店/区域：${ctx.storeOrRegion}` : '',
    ctx.platform ? `平台：${ctx.platform}` : '',
    ctx.rebatePolicy
      ? `返点口径（内部掌握，**绝不对达人说出具体数字**）：\n${ctx.rebatePolicy}`
      : '',
  ]
  return lines.filter(Boolean).join('\n')
}
