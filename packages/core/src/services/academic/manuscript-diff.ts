/**
 * 稿件版本比较（M7.3，纯函数无 IO）
 *
 * 用于「修订回复」场景：审稿意见要求改某处，作者需要证明**改了什么**。
 * 因此 diff 以章节为单位输出变化类型与行级差异，并单独列出
 * **主张引用的增删**——因为引用变化往往比文字变化更关键
 * （方案 §6.3：来源变化会影响主张，引用增删需可见）。
 */

import type { ManuscriptSection, ManuscriptVersion } from '@gravitas/shared'

export type SectionChangeKind = 'added' | 'removed' | 'modified' | 'unchanged'

export interface LineChange {
  type: 'added' | 'removed' | 'context'
  text: string
}

export interface SectionDiff {
  heading: string
  change: SectionChangeKind
  /** 行级差异（仅 changed 时非空；context 行用于定位） */
  lines: LineChange[]
  /** 主张引用的增删（关键：文字没变但引用变了也要暴露） */
  claimsAdded: string[]
  claimsRemoved: string[]
}

export interface ManuscriptDiff {
  fromVersion: number
  toVersion: number
  sections: SectionDiff[]
  claimsAdded: string[]
  claimsRemoved: string[]
  /** 变更理由（新版本若填写） */
  changeReason?: string
}

/**
 * 行级差异（简化 LCS：逐行比较，产出 removed 段 + added 段）。
 *
 * 不做完整 diff 算法——审稿回复场景需要的是「这一段被替换成什么」，
 * 而不是字符级最小编辑路径。逐行结果更易读也更易核对。
 */
function diffLines(oldText: string, newText: string): LineChange[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const changes: LineChange[] = []

  const max = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < max; i++) {
    const before = oldLines[i]
    const after = newLines[i]
    if (before === after) {
      if (before !== undefined && before.trim()) changes.push({ type: 'context', text: before })
      continue
    }
    if (before !== undefined) changes.push({ type: 'removed', text: before })
    if (after !== undefined) changes.push({ type: 'added', text: after })
  }

  return changes
}

function matchSections(
  from: ManuscriptSection[],
  to: ManuscriptSection[],
): Array<{ heading: string; before?: ManuscriptSection; after?: ManuscriptSection }> {
  const seen = new Set<string>()
  const pairs: Array<{ heading: string; before?: ManuscriptSection; after?: ManuscriptSection }> = []

  for (const section of from) {
    const match = to.find((s) => s.heading === section.heading)
    seen.add(section.heading)
    pairs.push({ heading: section.heading, before: section, after: match })
  }
  for (const section of to) {
    if (!seen.has(section.heading)) {
      pairs.push({ heading: section.heading, after: section })
    }
  }
  return pairs
}

/** 比较两个稿件版本 */
export function diffManuscriptVersions(
  from: ManuscriptVersion,
  to: ManuscriptVersion,
): ManuscriptDiff {
  const sections: SectionDiff[] = []
  const allClaimsAdded = new Set<string>()
  const allClaimsRemoved = new Set<string>()

  for (const pair of matchSections(from.sections, to.sections)) {
    const beforeClaims = pair.before?.claimIds ?? []
    const afterClaims = pair.after?.claimIds ?? []
    const claimsAdded = afterClaims.filter((c) => !beforeClaims.includes(c))
    const claimsRemoved = beforeClaims.filter((c) => !afterClaims.includes(c))
    for (const c of claimsAdded) allClaimsAdded.add(c)
    for (const c of claimsRemoved) allClaimsRemoved.add(c)

    let change: SectionChangeKind
    let lines: LineChange[] = []
    if (!pair.before) {
      change = 'added'
      lines = (pair.after?.content ?? '')
        .split('\n')
        .filter((l) => l.trim())
        .map((text) => ({ type: 'added' as const, text }))
    } else if (!pair.after) {
      change = 'removed'
      lines = pair.before.content
        .split('\n')
        .filter((l) => l.trim())
        .map((text) => ({ type: 'removed' as const, text }))
    } else if (pair.before.content === pair.after.content && claimsAdded.length === 0 && claimsRemoved.length === 0) {
      change = 'unchanged'
    } else {
      change = 'modified'
      if (pair.before.content !== pair.after.content) {
        lines = diffLines(pair.before.content, pair.after.content)
      }
    }

    sections.push({
      heading: pair.heading,
      change,
      lines,
      claimsAdded,
      claimsRemoved,
    })
  }

  return {
    fromVersion: from.version,
    toVersion: to.version,
    sections,
    claimsAdded: [...allClaimsAdded],
    claimsRemoved: [...allClaimsRemoved],
    changeReason: to.changeReason,
  }
}

/** 供审稿回复引用的变更摘要（人类可读，不夸大） */
export function describeDiffSummary(diff: ManuscriptDiff): string {
  const added = diff.sections.filter((s) => s.change === 'added').map((s) => s.heading)
  const removed = diff.sections.filter((s) => s.change === 'removed').map((s) => s.heading)
  const modified = diff.sections.filter((s) => s.change === 'modified').map((s) => s.heading)
  const parts: string[] = []
  if (added.length) parts.push(`新增章节：${added.join('、')}`)
  if (removed.length) parts.push(`删除章节：${removed.join('、')}`)
  if (modified.length) parts.push(`修改章节：${modified.join('、')}`)
  if (diff.claimsAdded.length) parts.push(`新增主张引用 ${diff.claimsAdded.length} 条`)
  if (diff.claimsRemoved.length) parts.push(`移除主张引用 ${diff.claimsRemoved.length} 条`)
  if (parts.length === 0) return `v${diff.fromVersion} → v${diff.toVersion}：内容未发生变化`
  return `v${diff.fromVersion} → v${diff.toVersion}：${parts.join('；')}`
}
