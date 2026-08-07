/**
 * 成员目录聚合服务 — Member Directory Service
 *
 * PH1-B（轻量）：把三类成员统一成一个可查询/可指派的「成员视图」，**不改底层表**：
 * - 真人（human）：来自 members 表（PH1-A 同步）
 * - AI 员工（agent）：来自 agent_employees 表
 * - 外部 bot（bot）：来自飞书/钉钉 Bot 配置
 *
 * 统一返回 shared 的 `MemberResult`（kind 区分），供团队 Tab、负责人选择器等一处查询。
 * 底层三张表各自保留，为后续彻底合并（重方案）留统一接口。
 */

import { listMembers, listAgentEmployees } from './project-sqlite-store'
import type { Member } from './project-types'
import type { MemberResult } from '@gravitas/shared'

export interface MemberDirectoryFilter {
  kind?: 'human' | 'agent' | 'bot'
  q?: string
  activeOnly?: boolean
}

/** 真人 memberId 前缀 `paa-`；AI 员工 `agent-`；bot `bot:<平台>:<id>` */
export const HUMAN_MEMBER_PREFIX = 'paa-'
export const AGENT_MEMBER_PREFIX = 'agent-'
export const BOT_MEMBER_PREFIX = 'bot:'

// ===== 真人 → MemberResult =====

function humanToMember(m: Member): MemberResult {
  return {
    memberId: `${HUMAN_MEMBER_PREFIX}${m.displayName}`,
    kind: 'human',
    displayName: m.displayName,
    department: m.department,
    feishuUserId: m.feishuUserId,
    feishuUnionId: m.feishuUnionId,
    dingtalkUserId: m.dingtalkUserId,
    dingtalkUnionId: m.dingtalkUnionId,
    source: m.source,
    active: m.active,
    lastSyncedAt: m.lastSyncedAt,
    createdAt: m.createdAt,
  }
}

// ===== AI 员工 → MemberResult =====

function agentToMember(a: {
  id: string
  name: string
  role: string
  avatar?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}): MemberResult {
  return {
    memberId: `${AGENT_MEMBER_PREFIX}${a.id}`,
    kind: 'agent',
    displayName: a.name,
    role: a.role,
    source: 'manual' as const,
    active: a.enabled,
    createdAt: a.updatedAt,
  }
}

// ===== bot → MemberResult =====

function botToMember(platform: 'feishu' | 'dingtalk', bot: { id: string; name: string; enabled?: boolean }): MemberResult | null {
  return {
    memberId: `${BOT_MEMBER_PREFIX}${platform}:${bot.id}`,
    kind: 'bot' as const,
    displayName: bot.name,
    role: `外部机器人 · ${platform === 'feishu' ? '飞书' : '钉钉'}`,
    platform,
    source: 'manual' as const,
    active: bot.enabled ?? true,
    createdAt: 0,
  }
}

// ===== 聚合 =====

const matchesQuery = (name: string, q?: string): boolean =>
  !q || name.toLowerCase().includes(q.trim().toLowerCase())

/**
 * 列出全部成员（真人 + AI 员工 + bot），支持 kind / q / activeOnly 过滤。
 * 统一成员视图的核心入口：团队 Tab、负责人选择器都从这拿成员。
 */
export async function listMemberDirectory(filter: MemberDirectoryFilter = {}): Promise<MemberResult[]> {
  const result: MemberResult[] = []

  // 1) 真人（members 已按 kind/activeOnly/q 支持；这里再按 q 局过滤一次统一口径）
  const humans = listMembers({ kind: 'human', activeOnly: filter.activeOnly })
  for (const m of humans) {
    if (!matchesQuery(m.displayName, filter.q)) continue
    result.push(humanToMember(m))
  }

  // 2) AI 员工（enabled 过滤）
  const agents = listAgentEmployees().filter((a) =>
    (!filter.activeOnly || a.enabled) && matchesQuery(a.name, filter.q)
  )
  for (const a of agents) {
    result.push(agentToMember(a))
  }

  // 3) 外部 bot（飞书 + 钉钉）——懒加载，避免无 electron 环境（单测）下崩溃
  let feishuBots: Array<{ id: string; name: string; enabled?: boolean }> = []
  let dingtalkBots: Array<{ id: string; name: string; enabled?: boolean }> = []
  try {
    const { getFeishuMultiBotConfig } = await import('./feishu-config')
    feishuBots = getFeishuMultiBotConfig().bots
  } catch {
    feishuBots = []
  }
  try {
    const { getDingTalkMultiBotConfig } = await import('./dingtalk-config')
    dingtalkBots = getDingTalkMultiBotConfig().bots
  } catch {
    dingtalkBots = []
  }
  for (const bot of feishuBots) {
    if (!matchesQuery(bot.name, filter.q)) continue
    const member = botToMember('feishu', bot)
    if (member && (!filter.activeOnly || member.active)) result.push(member)
  }
  for (const bot of dingtalkBots) {
    if (!matchesQuery(bot.name, filter.q)) continue
    const member = botToMember('dingtalk', bot)
    if (member && (!filter.activeOnly || member.active)) result.push(member)
  }

  // 按展示名排序
  return result
    .filter((m) => !filter.kind || m.kind === filter.kind)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'))
}

/** 统计：按 kind 分组数量（团队 Tab 概览用）。 */
export async function countMemberDirectory(): Promise<{ human: number; agent: number; bot: number }> {
  const all = await listMemberDirectory()
  return {
    human: all.filter((m) => m.kind === 'human').length,
    agent: all.filter((m) => m.kind === 'agent').length,
    bot: all.filter((m) => m.kind === 'bot').length,
  }
}
