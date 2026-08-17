import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import {
  clearBuiltinOverride,
  isBuiltinAgentId,
  readBuiltinOverrides,
  saveBuiltinOverride,
} from './builtin-agent-overrides'

const testDir = join(tmpdir(), `gravitas-eval-overrides-test-${Date.now()}`)

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

describe('builtin-agent-overrides', () => {
  it('saveBuiltinOverride 持久化并 read 读回', () => {
    saveBuiltinOverride('code-reviewer', '改进后的审查指令')
    const m = readBuiltinOverrides()
    expect(m['code-reviewer']?.prompt).toBe('改进后的审查指令')
  })

  it('clearBuiltinOverride 删除对应覆盖', () => {
    saveBuiltinOverride('explorer', '探索指令')
    clearBuiltinOverride('explorer')
    const m = readBuiltinOverrides()
    expect(m['explorer']).toBeUndefined()
  })

  it('isBuiltinAgentId 识别内置 id 且拒绝非内置', () => {
    expect(isBuiltinAgentId('code-reviewer')).toBe(true)
    expect(isBuiltinAgentId('explorer')).toBe(true)
    expect(isBuiltinAgentId('researcher')).toBe(true)
    expect(isBuiltinAgentId('workflow-xyz')).toBe(false)
  })
})
