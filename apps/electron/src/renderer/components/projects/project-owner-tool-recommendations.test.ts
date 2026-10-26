import { expect, test } from 'bun:test'
import { recommendOwnerStepTools } from './project-owner-tool-recommendations'
import type { ProjectOwnerPlanStep } from '@gravitas/shared'

const steps: ProjectOwnerPlanStep[] = [
  { key: 'research', title: '竞品研究', outcome: '形成竞品分析报告', acceptanceCriteria: ['列出竞品价格和市场数据'], dependencies: [], roleKey: 'researcher' },
  { key: 'write', title: '撰写方案', outcome: '形成中文方案文档', acceptanceCriteria: ['结构清晰且可审阅'], dependencies: [], roleKey: 'writer' },
]

test('Given 当前项目工作区有描述匹配能力 When 生成逐步骤推荐 Then 返回匹配理由并保持纯建议', () => {
  const recommendations = recommendOwnerStepTools(steps, 'project-workspace', [
    { workspaceId: 'project-workspace', mcpServers: [{ name: 'market-research', type: 'stdio' }], skills: [{ slug: 'competitor-research', name: '竞品研究', description: '研究竞品价格和市场数据' }] },
    { workspaceId: 'other-project-workspace', mcpServers: [{ name: 'competitor-research', type: 'stdio' }], skills: [] },
  ])
  expect(recommendations[0]?.candidates.map(({ id }) => id)).toContain('skill:competitor-research')
  expect(recommendations[0]?.candidates.every(({ reason }) => reason.includes('共有关键词'))).toBe(true)
  expect(recommendations[1]?.candidates).toEqual([])
})

test('Given无项目能力或文本无匹配 When推荐工具 Then返回空候选而不使用其它工作区能力', () => {
  expect(recommendOwnerStepTools(steps, 'missing', [{ workspaceId: 'other', mcpServers: [], skills: [{ slug: 'research', name: '研究', description: '分析资料' }] }]).every((item) => item.candidates.length === 0)).toBe(true)
  expect(recommendOwnerStepTools(steps, 'project-workspace', [{ workspaceId: 'project-workspace', mcpServers: [], skills: [{ slug: 'calendar', name: '日历', description: '日程安排' }] }]).every((item) => item.candidates.length === 0)).toBe(true)
})
