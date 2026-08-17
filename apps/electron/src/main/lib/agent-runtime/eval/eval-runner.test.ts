import { describe, expect, it } from 'bun:test'
import { buildBuiltinStateGuard, readBuiltinPrompt } from './builtin-agent-state'

describe('buildBuiltinStateGuard', () => {
  it('对内置 code-reviewer 做版本化快照与应用/回滚', async () => {
    const guard = buildBuiltinStateGuard('code-reviewer')
    const v0 = guard.version()
    const originalPrompt = readBuiltinPrompt('code-reviewer')
    expect(originalPrompt.length).toBeGreaterThan(0)

    // 与 self-evolver 用法一致：每个候选前 snapshot
    await guard.snapshot("t")
    await guard.apply({ description: 'tweak', target: 'code-reviewer', afterState: { prompt: '新版审查指令' } })
    const v1 = guard.version()
    expect(v1).toBe(v0 + 1)

    // 回滚到上一个快照（基线）
    await guard.restore()
    expect(guard.version()).toBe(v0)
    expect(guard.currentPrompt()).toBe(originalPrompt)

    // 再 snapshot → apply 新候选
    await guard.snapshot("t")
    await guard.apply({ description: 'again', target: 'code-reviewer', afterState: '字符串版指令' })
    expect(guard.version()).toBe(v0 + 1)
    await guard.restore()
    expect(guard.version()).toBe(v0)
  })

  it('未知内置子代理抛错', () => {
    expect(() => buildBuiltinStateGuard('does-not-exist')).toThrow()
  })

  it('readBuiltinPrompt 返回非空审查指令', () => {
    const p = readBuiltinPrompt('code-reviewer')
    expect(p).toContain('审查')
  })
})
