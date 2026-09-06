import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPluginToolsDir } from '../../config-paths'
import { resolveEvalTargetCapability } from './eval-target-capability'

const testDir = join(tmpdir(), `proma-eval-target-capability-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir

  const pluginDir = getPluginToolsDir('marketing-eval')
  const toolDir = join(pluginDir, 'shared', 'storyboard')
  mkdirSync(toolDir, { recursive: true })
  writeFileSync(join(pluginDir, 'system_config.json'), JSON.stringify({ id: 'marketing-eval', version: 3, domains: ['shared'] }), 'utf-8')
  writeFileSync(join(pluginDir, 'TOOLS.md'), '调用 ma_generate_storyboard 生成分镜。', 'utf-8')
  // 复用已有安全的代码 fallback，证明目录定义会解析为真正可执行的 RuntimeToolDefinition。
  writeFileSync(join(toolDir, 'tool.json'), JSON.stringify({
    id: 'ma_generate_storyboard',
    name: '分镜生成',
    description: '生成营销分镜',
    domain: 'shared',
    parameters: { type: 'object', properties: {} },
  }), 'utf-8')
  writeFileSync(join(toolDir, 'execute.ts'), 'export async function execute(input: unknown): Promise<string> { return JSON.stringify(input) }', 'utf-8')
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(testDir, { recursive: true, force: true })
})

describe('评测目标能力解析', () => {
  it('Toolset 从目录解析真实执行工具，并冻结版本、来源与 hash', () => {
    const capability = resolveEvalTargetCapability({ type: 'toolset', id: 'marketing-eval' })

    expect(capability.source).toBe('directory')
    expect(capability.version).toBe(3)
    expect(capability.contentHash).toHaveLength(64)
    expect(capability.systemPrompt).toContain('ma_generate_storyboard')
    expect(capability.runtimeTools.map((tool) => tool.name)).toEqual(['ma_generate_storyboard'])
    expect(typeof capability.runtimeTools[0]?.execute).toBe('function')
  })

  it('Agent 目录缺失时明确标记 code fallback', () => {
    const capability = resolveEvalTargetCapability({ type: 'agent', id: 'code-reviewer' })

    expect(capability.source).toBe('code-fallback')
    expect(capability.version).toBe(0)
    expect(capability.systemPrompt).toContain('审查')
  })

  it('目录内容变化会改变能力 hash，避免评测结果失去可复现性', () => {
    const before = resolveEvalTargetCapability({ type: 'toolset', id: 'marketing-eval' })
    writeFileSync(join(getPluginToolsDir('marketing-eval'), 'TOOLS.md'), '更新后的工具说明。', 'utf-8')
    const after = resolveEvalTargetCapability({ type: 'toolset', id: 'marketing-eval' })

    expect(after.contentHash).not.toBe(before.contentHash)
  })
})
