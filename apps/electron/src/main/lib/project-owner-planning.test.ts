import { describe, expect, test } from 'bun:test'
import {
  parseProjectOwnerPlanProposal,
  prepareProjectOwnerGoalBrief,
} from './project-owner-planning'

const goalInput = {
  projectId: 'project-1',
  goalVersion: 1,
  objective: '形成可评审的产品定位方案',
}

function planInput() {
  return {
    projectId: 'project-1',
    goalVersion: 1,
    summary: '先整理资料，再提出定位与评审建议',
    assumptions: ['现有产品资料可供整理'],
    risks: ['用户研究不足时需澄清'],
    steps: [
      { key: 'research', title: '梳理资料', outcome: '资料摘要', acceptanceCriteria: ['来源可定位'], dependencies: [], roleKey: 'researcher' },
      { key: 'positioning', title: '提出定位', outcome: '定位方案', acceptanceCriteria: ['列出推荐及备选'], dependencies: ['research'], roleKey: 'strategist' },
    ],
  }
}

function parse(input: unknown = planInput()) {
  return parseProjectOwnerPlanProposal(input, prepareProjectOwnerGoalBrief(goalInput), ['researcher', 'strategist'])
}

describe('Given 人类仅提供非代码项目目标', () => {
  test('Then 可形成简报，不要求文件、Git、员工或执行预算', () => {
    const goal = prepareProjectOwnerGoalBrief(goalInput)
    expect(goal).toEqual({ ...goalInput, constraints: [], acceptanceCriteria: [] })
  })

  test('Then 保留明确约束与标准，规范空白且不修改输入', () => {
    const input = { ...goalInput, objective: '  产品定位  ', constraints: ['  仅用授权资料  '], acceptanceCriteria: ['  提供两种选项  '] }
    const brief = prepareProjectOwnerGoalBrief(input)
    expect(brief.objective).toBe('产品定位')
    expect(brief.constraints).toEqual(['仅用授权资料'])
    brief.constraints.push('新约束')
    expect(input.constraints).toEqual(['  仅用授权资料  '])
  })

  test('Then 拒绝空目标、非法项目身份、版本和数据类型', () => {
    for (const input of [null, [], { ...goalInput, objective: ' ' }, { ...goalInput, projectId: ' ' }, { ...goalInput, goalVersion: 0 }, { ...goalInput, goalVersion: 1.5 }, { ...goalInput, constraints: '任意范围' }]) {
      expect(() => prepareProjectOwnerGoalBrief(input)).toThrow()
    }
  })

  test('Then 不接收暗含执行权限的字段', () => {
    expect(() => prepareProjectOwnerGoalBrief({ ...goalInput, permissionMode: 'allow-all' })).toThrow('未知字段')
  })
})

describe('Given Owner 提出的结构化计划', () => {
  test('Then 合法依赖计划始终仅为建议，不产生任务/授权/完成事实', () => {
    const proposal = parse()
    expect(proposal.mode).toBe('proposal_only')
    expect(proposal.steps).toHaveLength(2)
    expect(proposal).not.toHaveProperty('grantId')
    expect(proposal.steps[0]).not.toHaveProperty('taskId')
    expect(proposal.steps[0]).not.toHaveProperty('status')
  })

  test('Then 允许合法前向依赖，不强迫模型按拓扑顺序排列', () => {
    const input = planInput()
    input.steps.reverse()
    expect(parse(input).steps[0]?.dependencies).toEqual(['research'])
  })

  test('Then 返回规范化副本，不能通过原始模型对象改变校验结果', () => {
    const input = planInput()
    input.summary = '  先研究  '
    const result = parse(input)
    input.steps[1]!.dependencies.push('phantom')
    input.assumptions.push('后加假设')
    expect(result.summary).toBe('先研究')
    expect(result.steps[1]?.dependencies).toEqual(['research'])
    expect(result.assumptions).toHaveLength(1)
  })

  test('Then 跨项目与过期目标版本均拒绝', () => {
    expect(() => parse({ ...planInput(), projectId: 'project-2' })).toThrow('项目')
    expect(() => parse({ ...planInput(), goalVersion: 2 })).toThrow('版本')
  })

  test('Then 单任务目标可规划，但不能换绑或遗漏任务身份', () => {
    const goal = prepareProjectOwnerGoalBrief({ ...goalInput, taskId: 'task-1' })
    const input = { ...planInput(), taskId: 'task-1' }
    expect(parseProjectOwnerPlanProposal(input, goal, ['researcher', 'strategist']).taskId).toBe('task-1')
    expect(() => parseProjectOwnerPlanProposal(planInput(), goal, ['researcher', 'strategist'])).toThrow('任务')
    expect(() => parseProjectOwnerPlanProposal({ ...input, taskId: 'task-2' }, goal, ['researcher', 'strategist'])).toThrow('任务')
    expect(() => parse(input)).toThrow('任务')
  })

  test('Then 不能将非法任务身份静默降级为项目目标', () => {
    expect(() => prepareProjectOwnerGoalBrief({ ...goalInput, taskId: ' ' })).toThrow('taskId')
    expect(() => prepareProjectOwnerGoalBrief({ ...goalInput, taskId: null })).toThrow('taskId')
  })

  test('Then 必须提供成果、验收标准和可用角色', () => {
    for (const field of ['title', 'outcome', 'roleKey'] as const) {
      const input = planInput()
      input.steps[0]![field] = ' '
      expect(() => parse(input)).toThrow()
    }
    const input = planInput()
    input.steps[0]!.acceptanceCriteria = []
    expect(() => parse(input)).toThrow('acceptanceCriteria')
    expect(() => parseProjectOwnerPlanProposal(planInput(), prepareProjectOwnerGoalBrief(goalInput), ['researcher'])).toThrow('不可用角色')
  })

  test('Then 拒绝不存在、自依赖、重复依赖和环', () => {
    for (const dependencies of [['missing'], ['research'], ['positioning', 'positioning']]) {
      const input = planInput()
      input.steps[0]!.dependencies = dependencies
      expect(() => parse(input)).toThrow()
    }
    const input = planInput()
    input.steps[0]!.dependencies = ['positioning']
    expect(() => parse(input)).toThrow('循环依赖')
  })

  test('Then 拒绝重复任务身份及空/重复验收标准', () => {
    const duplicated = planInput()
    duplicated.steps[1]!.key = 'research'
    expect(() => parse(duplicated)).toThrow('重复任务')
    for (const criteria of [[' '], ['来源可定位', ' 来源可定位 ']]) {
      const input = planInput()
      input.steps[0]!.acceptanceCriteria = criteria
      expect(() => parse(input)).toThrow()
    }
  })

  test('Then 拒绝模型夹带执行、授权或已完成声明', () => {
    for (const field of ['grantId', 'permissionMode', 'status', 'mode']) {
      expect(() => parse({ ...planInput(), [field]: 'approved' })).toThrow('未知字段')
    }
    const input = planInput()
    expect(() => parse({ ...input, steps: [{ ...input.steps[0], completed: true }] })).toThrow('未知字段')
  })

  test('Then 没有步骤或超出输入上限时拒绝', () => {
    expect(() => parse({ ...planInput(), steps: [] })).toThrow('steps')
    const step = planInput().steps[0]!
    expect(() => parse({ ...planInput(), steps: Array.from({ length: 33 }, (_, index) => ({ ...step, key: `step-${index}` })) })).toThrow('steps')
    expect(() => prepareProjectOwnerGoalBrief({ ...goalInput, objective: '字'.repeat(12001) })).toThrow('objective')
  })

  test('Then 不接受非 JSON 对象、非法数组和数字文本', () => {
    for (const input of [null, [], { ...planInput(), goalVersion: '1' }, { ...planInput(), assumptions: [2] }, { ...planInput(), risks: null }, { ...planInput(), steps: [null] }]) {
      expect(() => parse(input)).toThrow()
    }
  })
})
