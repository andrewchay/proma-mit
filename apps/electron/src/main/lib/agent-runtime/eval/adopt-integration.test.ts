import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { saveBuiltinOverride, clearBuiltinOverride } from './builtin-agent-overrides'
import { buildBuiltinAgents } from '../../agent-prompt-builder'

const testDir = join(tmpdir(), `gravitas-eval-adopt-integration-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
})

describe('采纳写回集成（override → buildBuiltinAgents 生效）', () => {
  it('保存覆盖后 buildBuiltinAgents 返回新 prompt（非代码默认）', () => {
    const codeDefault = buildBuiltinAgents(false)['code-reviewer']!.prompt!
    expect(codeDefault.length).toBeGreaterThan(0)

    saveBuiltinOverride('code-reviewer', '【采纳版】更严格更具体的审查指令')
    const adopted = buildBuiltinAgents(false)['code-reviewer']!.prompt!
    expect(adopted).toContain('【采纳版】')
    expect(adopted).not.toBe(codeDefault)
  })

  it('清除覆盖后恢复代码默认', () => {
    clearBuiltinOverride('code-reviewer')
    const restored = buildBuiltinAgents(false)['code-reviewer']!.prompt!
    expect(restored).not.toContain('【采纳版】')
  })

  it('未受影响的子代理保持默认', () => {
    const explorer = buildBuiltinAgents(false)['explorer']!.prompt!
    expect(explorer).toContain('探索')
  })
})
