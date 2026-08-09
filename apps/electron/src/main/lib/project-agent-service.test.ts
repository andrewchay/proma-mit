import { describe, test, expect } from 'bun:test'
import {
  parseTaskExtractionResponse,
  buildTaskExtractionPrompt,
  extractedTaskToDraftInput,
} from './project-agent-service'

describe('parseTaskExtractionResponse - JSON 数组格式（新版 Prompt 约定）', () => {
  test('解析带章节/负责人/优先级的 JSON to-do 数组', () => {
    const json = JSON.stringify([
      {
        title: '收集现有产品利润率信息',
        description: '@用户664170牵头进行业务侧现有产品利润率信息收集，协同业务完成全流程信息人力处理',
        assignee: '用户664170',
        priority: 'high',
        category: '业务战略优化',
        dueDate: '',
      },
      {
        title: '协同业务建立长线执行节奏',
        description: '@用户664170协同业务建立长线执行节奏',
        assignee: '用户664170',
        priority: 'medium',
        category: '业务战略优化',
        dueDate: '',
      },
      {
        title: '检测全链路 agent 代操作可行性',
        description: '@Andrew检测全链路后续是否可以agent代操作，也可以一起设置策略制定的方法论',
        assignee: 'Andrew',
        priority: 'medium',
        category: '业务战略优化',
        dueDate: '',
      },
    ])
    const tasks = parseTaskExtractionResponse(json)
    expect(tasks).toHaveLength(3)
    expect(tasks[0]).toMatchObject({
      title: '收集现有产品利润率信息',
      assignee: '用户664170',
      category: '业务战略优化',
      priority: 'high',
    })
    expect(tasks[2]!.assignee).toBe('Andrew')
  })

  test('空数组 [] 表示无任务', () => {
    const tasks = parseTaskExtractionResponse('[]')
    expect(tasks).toHaveLength(0)
  })

  test('兼容 ```json fenced 输出', () => {
    const raw = '```json\n[{"title":"搭建达人回复机器人","description":"自动回复","assignee":"Andrew","category":"推广执行优化"}]\n```'
    const tasks = parseTaskExtractionResponse(raw)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.assignee).toBe('Andrew')
    expect(tasks[0]!.category).toBe('推广执行优化')
  })
})

describe('parseTaskExtractionResponse - mentions 清洗与标题精炼', () => {
  test('@某人 前后缀被清洗为纯人名，@Andrew待定 去除后缀', () => {
    // 通过 JSON 路径验证（assignee 清洗）
    const raw = JSON.stringify([
      { title: '搭建机器人', description: '', assignee: 'Andrew待定', priority: 'low', category: '推广执行优化' },
      { title: '建小红书专业号', description: '', assignee: '@用户664170牵头', priority: 'medium' },
    ])
    const tasks = parseTaskExtractionResponse(raw)
    expect(tasks[0]!.assignee).toBe('Andrew')
    expect(tasks[1]!.assignee).toBe('用户664170')
  })

  test('标题尾部“待定/后续”被移除', () => {
    const raw = JSON.stringify([{ title: '达人圈选逻辑优化待定', description: '', priority: 'low' }])
    const tasks = parseTaskExtractionResponse(raw)
    expect(tasks[0]!.title).toBe('达人圈选逻辑优化')
  })
})

describe('parseTaskExtractionResponse - Markdown 回退路径', () => {
  test('旧版 Markdown 编号列表格式仍能解析（兼容）', () => {
    const raw = `## 提取结果

1. 搭建达人回复机器人
   - 描述: @Andrew智能回复达人
   - 负责人: Andrew
   - 优先级: high
   - 章节: 推广执行优化

2. 建立小红书专业号
   - 描述: @用户664170建立
   - 负责人: 用户664170
   - 优先级: medium`
    const tasks = parseTaskExtractionResponse(raw)
    expect(tasks).toHaveLength(2)
    expect(tasks[0]!.title).toBe('搭建达人回复机器人')
    expect(tasks[0]!.category).toBe('推广执行优化')
    expect(tasks[1]!.title).toBe('建立小红书专业号')
  })

  test('明确“没有 Action Items”返回空', () => {
    const tasks = parseTaskExtractionResponse('本次纪要没有 Action Items')
    expect(tasks).toHaveLength(0)
  })
})

describe('buildTaskExtractionPrompt', () => {
  test('包含区分动作描述与真实 To-do 的指引，并约定 JSON 输出', () => {
    const prompt = buildTaskExtractionPrompt('某纪要内容')
    expect(prompt).toContain('动作描述')
    expect(prompt).toContain('真实 To-do')
    expect(prompt).toContain('JSON')
    expect(prompt).toContain('category')
    expect(prompt).toContain('某纪要内容')
  })
})

describe('extractedTaskToDraftInput', () => {
  test('category 前缀写入描述，保留 assignee 与优先级', () => {
    const input = extractedTaskToDraftInput({
      title: '搭建达人回复机器人',
      description: '自动回复达人消息',
      assignee: 'Andrew',
      priority: 'high',
      category: '推广执行优化',
    })
    expect(input.title).toBe('搭建达人回复机器人')
    expect(input.description).toContain('【推广执行优化】')
    expect(input.assignee).toEqual({ userId: 'Andrew', displayName: 'Andrew' })
    expect(input.priority).toBe('high')
  })

  test('无 category 时不加前缀', () => {
    const input = extractedTaskToDraftInput({
      title: '普通任务',
      description: '无分类',
      priority: 'medium',
    })
    expect(input.description).toBe('无分类')
  })
})
