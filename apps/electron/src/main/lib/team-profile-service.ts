/**
 * 团队档案服务 — Team Profile Service（PH2-A）
 *
 * 「最简有效的大上下文同步」：为团队（以工作区为边界）维护一份精简档案，
 * 供 Agent 在会话中了解团队背景并以合适的方式协作。
 *
 * 存储：~/.proma/team-profiles.json（workspaceSlug → TeamProfile）。
 * 不搞全量人员画像，只保留最简：团队名 / 关注方向 / 协作偏好 / 成员摘要。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export interface TeamProfile {
  /** 团队名 */
  teamName: string
  /** 团队成员摘要（名字：职责，可手工维护或从成员目录生成） */
  membersSummary: string
  /** 团队关注/当前方向 */
  focusAreas: string
  /** 协作偏好（如「结果中文」「周报时间」「代码规范」等） */
  preferences: string
  /** 最近更新时间 */
  updatedAt: number
}

export type TeamProfilePatch = Partial<Pick<TeamProfile, 'teamName' | 'membersSummary' | 'focusAreas' | 'preferences'>>

const DEFAULT_PROFILE: Omit<TeamProfile, 'updatedAt'> = {
  teamName: '',
  membersSummary: '',
  focusAreas: '',
  preferences: '',
}

function profilesFile(): string {
  const dir = join(getConfigDir(), 'team-profiles')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'profiles.json')
}

function readAll(): Record<string, TeamProfile> {
  try {
    const file = profilesFile()
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, TeamProfile>
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, TeamProfile>): void {
  writeFileSync(profilesFile(), JSON.stringify(map, null, 2), 'utf-8')
}

/** 读取某工作区的团队档案（不存在返回默认空档案）。 */
export function getTeamProfile(workspaceSlug: string): TeamProfile {
  const all = readAll()
  return all[workspaceSlug] ?? { ...DEFAULT_PROFILE, updatedAt: 0 }
}

/** 更新某工作区的团队档案（浅合并，保留未提供的字段）。 */
export function updateTeamProfile(workspaceSlug: string, patch: TeamProfilePatch): TeamProfile {
  const all = readAll()
  const existing = all[workspaceSlug] ?? { ...DEFAULT_PROFILE, updatedAt: 0 }
  const next: TeamProfile = {
    teamName: patch.teamName ?? existing.teamName,
    membersSummary: patch.membersSummary ?? existing.membersSummary,
    focusAreas: patch.focusAreas ?? existing.focusAreas,
    preferences: patch.preferences ?? existing.preferences,
    updatedAt: Date.now(),
  }
  all[workspaceSlug] = next
  writeAll(all)
  return next
}

/** 生成给 Agent 的「团队上下文」文本（注入 system prompt 的动态部分）。 */
export function buildTeamProfileContext(workspaceSlug: string): string {
  const p = getTeamProfile(workspaceSlug)
  if (!p.teamName && !p.focusAreas && !p.membersSummary && !p.preferences) return ''
  const lines = [
    p.teamName && `团队: ${p.teamName}`,
    p.membersSummary && `团队构成: ${p.membersSummary}`,
    p.focusAreas && `当前方向: ${p.focusAreas}`,
    p.preferences && `协作偏好: ${p.preferences}`,
  ].filter(Boolean)
  return lines.length > 0 ? `\n【团队上下文】\n${lines.join('\n')}` : ''
}
