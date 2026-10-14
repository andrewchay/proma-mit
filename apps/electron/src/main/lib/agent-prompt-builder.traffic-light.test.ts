/**
 * agent-prompt-builder 红绿灯约定注入测试
 *
 * 验证 Claude SDK / Pi 共用的 buildSystemPrompt 注入任务完成态红绿灯，
 * 以及内置子代理（explorer / researcher）要求末尾状态行。
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const testDir = join(tmpdir(), `gravitas-traffic-light-test-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(testDir, { recursive: true, force: true })
})

const { buildSystemPrompt, buildBuiltinAgents, TRAFFIC_LIGHT_GUIDE } = await import('./agent-prompt-builder')

describe('任务完成态红绿灯注入', () => {
  it('given 默认上下文 when 构建 Claude/Pi system prompt then 包含红绿灯约定', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'test-session',
      permissionMode: 'safe',
      memoryEnabled: false,
    })

    expect(prompt).toContain('## 任务完成态红绿灯')
    expect(prompt).toContain('最后一个非空行必须是进度状态行')
    expect(prompt).toContain('🔴 原始需求有未达项')
    expect(prompt).toContain('转黄或转绿之后立即停手')
  })

  it('given 红绿灯常量 when 检查格式约定 then 与 shared 解析规则对齐（末行 emoji 开头）', () => {
    // 状态行约定必须是「最后一个非空行以单个 emoji 开头」，
    // 这与 parseAgentCompletionStatus 的解析规则一致。
    expect(TRAFFIC_LIGHT_GUIDE).toContain('🟢')
    expect(TRAFFIC_LIGHT_GUIDE).toContain('🟡')
    expect(TRAFFIC_LIGHT_GUIDE).toContain('🔴')
    expect(TRAFFIC_LIGHT_GUIDE).toContain('.context/plan/')
  })

  it('given 内置子代理 when 检查 explorer 与 researcher then 要求末尾状态行', () => {
    const agents = buildBuiltinAgents(false)

    expect(agents['explorer']!.prompt).toContain('🟢')
    expect(agents['explorer']!.prompt).toContain('最后一个非空行')
    expect(agents['researcher']!.prompt).toContain('🟡')
    expect(agents['researcher']!.prompt).toContain('最后一个非空行')
    // code-reviewer 已用同样 emoji 表示严重度分级，不得混入红绿灯语义
    expect(agents['code-reviewer']!.prompt).not.toContain('任务状态')
  })
})
