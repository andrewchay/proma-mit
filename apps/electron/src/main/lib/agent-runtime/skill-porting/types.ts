/**
 * Skill-Porting 编排层的类型。
 */

import type { AuditReport } from './skill-auditor'

/** 来源 spec 解析后的描述。 */
export interface PortSkillResult {
  workspaceSlug: string
  skillSlug: string
  /** 审计结论：safe/review/blocked */
  audit: AuditReport
  /** 是否已安装（blocked=false 且（safe 或人工确认 review）时 true） */
  installed: boolean
  /** 已安装的路径 */
  installPath?: string
  /** 固定 revision（commit sha） */
  pinnedRev?: string
  /** 原始 spec */
  requestedSpec: string
}

/** 外部 skill 来源 spec。 */
export interface SkillPortingSpec {
  /** 原始描述，支持：GitHub repo、skills.sh 名、SKILL.md URL */
  spec: string
  /** 可选固定 revision */
  rev?: string
  /** 可选 GitHub 子目录 */
  subdir?: string
  /** 默认启用 */
  enabled?: boolean
}
