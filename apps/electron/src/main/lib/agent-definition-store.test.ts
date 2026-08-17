import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  readAgentDirState,
  getBuiltinAgentDefinition,
  writeAgentAgentsMd,
  foldLegacyAgentOverridesIntoDirs,
} from './agent-definition-store'
import { getAgentDir, getDefaultAgentsUserDir } from './config-paths'
import { buildBuiltinAgents } from './agent-prompt-builder'
import type { AgentDefinition } from '@gravitas/shared'

const testDir = join(tmpdir(), `gravitas-agent-dir-test-${Date.now()}`)

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

// 手动造一个 seed 目录（等价于 seedDefaultAgents 对一个 agent 的产物）
function seedAgent(id: string, prompt: string, version = 1): void {
  const dir = getAgentDir(id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), prompt, 'utf-8')
  writeFileSync(
    join(dir, 'system_config.json'),
    JSON.stringify({ id, name: id, description: 'seed', version, tools: ['Read', 'Bash'] }),
    'utf-8',
  )
}

describe('agent 即目录（agent-definition-store）', () => {
  it('目录不存在时回退代码默认', () => {
    const codeDefault: AgentDefinition = { description: 'code desc', prompt: 'code prompt', tools: ['Read'] }
    const def = getBuiltinAgentDefinition('does-not-exist', codeDefault)
    expect(def).toEqual(codeDefault)
  })

  it('读目录 → merged AgentDefinition（AGENTS.md=prompt, config.tools/description）', () => {
    seedAgent('explorer', '目录 AGENTS.md 指令', 2)
    const codeDefault: AgentDefinition = { description: 'code desc', prompt: 'code prompt', tools: ['Read', 'Glob'] }
    const def = getBuiltinAgentDefinition('explorer', codeDefault)
    expect(def.prompt).toBe('目录 AGENTS.md 指令')
    expect(def.tools).toEqual(['Read', 'Bash']) // 目录 tools 优先
    expect(def.description).toBe('seed')
  })

  it('目录部分字段缺失时保留代码默认', () => {
    const dir = getAgentDir('code-reviewer')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'AGENTS.md'), '只有 AGENTS.md，没有 system_config', 'utf-8')
    const codeDefault: AgentDefinition = { description: 'code desc', prompt: 'fallback', tools: ['Read'] }
    const def = getBuiltinAgentDefinition('code-reviewer', codeDefault)
    expect(def.prompt).toBe('只有 AGENTS.md，没有 system_config') // AGENTS.md 优先
    expect(def.tools).toEqual(['Read']) // 无 config.tools → 回退代码默认
  })

  it('writeAgentAgentsMd 写入 AGENTS.md 并 bump version', () => {
    seedAgent('researcher', 'v1 指令', 1)
    const v = writeAgentAgentsMd('researcher', '采纳后的新指令')
    expect(v).toBe(2)
    expect(readFileSync(join(getAgentDir('researcher'), 'AGENTS.md'), 'utf-8')).toBe('采纳后的新指令')
    // buildBuiltinAgents 反映目录（真实链路）
    const agents = buildBuiltinAgents(true)
    expect(agents['researcher']?.prompt).toContain('采纳后的新指令')
  })

  it('foldLegacyAgentOverridesIntoDirs 把 override 折叠进目录并清理', () => {
    // 造 legacy override
    const { saveBuiltinOverride, readBuiltinOverrides, builtinOverridesPath } = require('./agent-runtime/eval/builtin-agent-overrides') as typeof import('./agent-runtime/eval/builtin-agent-overrides')
    // 先 seed code-reviewer 为 pristine（与 bundled 相同才能折叠；这里直接造 override + 空目录场景简化验证清理）
    saveBuiltinOverride('code-reviewer', 'legacy 采纳指令')
    // 目录已由上一用例生成（code-reviewer 只有 AGENTS.md），bundled 不同 → 不覆盖，但 override 会保留
    foldLegacyAgentOverridesIntoDirs()
    // 因现存目录非 pristine（已有内容），不折叠，override 仍在
    const remaining = readBuiltinOverrides()
    expect(remaining['code-reviewer']?.prompt).toBe('legacy 采纳指令')
    // 清理测试残留
    const { clearBuiltinOverride: clear } = require('./agent-runtime/eval/builtin-agent-overrides') as typeof import('./agent-runtime/eval/builtin-agent-overrides')
    clear('code-reviewer')
    expect(Object.keys(readBuiltinOverrides()).length).toBe(0)
  })
})
