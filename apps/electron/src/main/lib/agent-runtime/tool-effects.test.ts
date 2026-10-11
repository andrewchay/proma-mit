import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityDescriptor } from '@gravitas/shared'
import type { RuntimeToolDefinition } from './types'
import { buildElectronMock } from '../testing/electron-mock'

const dir = mkdtempSync(join(tmpdir(), 'gravitas-effects-'))
const oldConfig = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = dir
mock.module('electron', () => buildElectronMock())
const { bindCoreToolEffects, getRegisteredToolEffects, assessCapabilityToolEffects } = await import('./tool-effects')
const { createCoreTools } = await import('./tool-registry')
const { executeReadTool } = await import('./tool-impls/read-tool')
let tools: RuntimeToolDefinition[]
beforeAll(() => { tools = createCoreTools() })
afterAll(async () => {
  await Bun.sleep(20)
  if (oldConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = oldConfig
  rmSync(dir, { recursive: true, force: true })
})
const unknown = { version: 1, resources: [{ kind: 'unknown' }], replay: 'never' } as const
function descriptor(change: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return { version: 1, id: 'builtin:read', name: '读取文件', summary: 'fixture', source: 'builtin', schemaRef: 'builtin:read:v1', access: 'read', dataClasses: ['workspace'], confirmation: 'never', parallelSafe: true, toolName: 'Read', ...change }
}
function tool(name: string): RuntimeToolDefinition { return tools.find((t) => t.name === name)! }

describe('编译工具实例effects绑定（未启用调度）', () => {
  test('三个真实core实例声明与执行同源，Write涵盖递归父目录创建', () => {
    expect(tool('Read').execute).toBe(executeReadTool)
    for (const [name, mode, scope] of [['Read', 'read', 'path'], ['Write', 'write', 'path-and-ancestors'], ['Edit', 'write', 'path']] as const) {
      expect(getRegisteredToolEffects(tool(name))).toMatchObject({ resources: [{ kind: 'filesystem', mode, pathParameter: 'file_path', scope }] })
    }
    expect(tool('Read').parameters.required).toContain('file_path')
  })
  test('元数据不改变schema或Read/Write/Edit实际执行', async () => {
    const ctx = { cwd: dir, sessionId: 'fixture' }
    expect((await tool('Write').execute({ file_path: 'nested/data.txt', content: 'one\ntwo' }, ctx)).isError).not.toBe(true)
    expect((await tool('Read').execute({ file_path: 'nested/data.txt' }, ctx)).content).toBe('one\ntwo')
    expect((await tool('Edit').execute({ file_path: 'nested/data.txt', old_string: 'two', new_string: 'three' }, ctx)).isError).not.toBe(true)
    expect((await tool('Read').execute({ file_path: 'nested/data.txt', offset: 1, limit: 1 }, ctx)).content).toBe('three')
    expect(tool('Write').parameters.required).toContain('content')
    expect(tool('Edit').parameters.required).toContain('old_string')
  })
  test('Bash/Grep与其他工具未按名称或只读提示升级', () => {
    for (const t of tools.filter((t) => !['Read', 'Write', 'Edit'].includes(t.name))) expect(getRegisteredToolEffects(t)).toEqual(unknown)
  })
  test('同名DTO、副本、伪execute和MCP提示无法绑定', () => {
    const original = tool('Read')
    expect(getRegisteredToolEffects({ ...original })).toEqual(unknown)
    const fake = { ...original, execute: async () => ({ toolCallId: '', content: 'fake' }) }
    bindCoreToolEffects(fake)
    expect(getRegisteredToolEffects(fake)).toEqual(unknown)
    const mcp = { ...original, name: 'mcp__server__Read', readOnlyHint: true }
    bindCoreToolEffects(mcp)
    expect(getRegisteredToolEffects(mcp)).toEqual(unknown)
  })
  for (const field of ['execute', 'name', 'effects'] as const) {
    test(`注册后替换${field}失效`, () => {
      const fresh = createCoreTools().find((t) => t.name === 'Read')!
      if (field === 'execute') fresh.execute = async () => ({ toolCallId: '', content: 'fake' })
      else if (field === 'name') fresh.name = 'Bash'
      else fresh.effects = { version: 1, resources: [{ kind: 'unknown' }], replay: 'never' }
      expect(getRegisteredToolEffects(fresh)).toEqual(unknown)
    })
  }
  test('返回独立副本；原metadata冻结；getter不被调用', () => {
    const fresh = createCoreTools().find((t) => t.name === 'Read')!
    expect(Object.isFrozen(fresh.effects?.resources[0])).toBe(true)
    const copy = getRegisteredToolEffects(fresh)
    expect(copy).not.toBe(fresh.effects)
    let calls = 0
    Object.defineProperty(fresh, 'execute', { get: () => { calls++; return executeReadTool } })
    expect(getRegisteredToolEffects(fresh)).toEqual(unknown)
    expect(calls).toBe(0)
  })
  test('catalog嵌套数据类别getter也不能被读取', () => {
    let calls = 0
    const classes = ['workspace']
    Object.defineProperty(classes, '0', { get: () => { calls++; return 'workspace' } })
    expect(assessCapabilityToolEffects(descriptor({ dataClasses: classes as CapabilityDescriptor['dataClasses'] }), tool('Read')).independentReadCandidate).toBe(false)
    expect(calls).toBe(0)
  })
  test('catalog只按实际对象投影；parallelSafe只能收紧候选，不改变声明', () => {
    const d = descriptor()
    const result = assessCapabilityToolEffects(d, tool('Read'))
    expect(result.independentReadCandidate).toBe(true)
    const serial = assessCapabilityToolEffects({ ...d, parallelSafe: false }, tool('Read'))
    expect(serial.independentReadCandidate).toBe(false)
    expect(serial.effects).toEqual(result.effects)
    for (const altered of [descriptor({ source: 'mcp', serverName: 'fake' }), descriptor({ source: 'workspace' }), descriptor({ toolName: 'Write' }), descriptor({ access: 'write' }), descriptor({ toolName: undefined }), Object.create(d)]) {
      expect(assessCapabilityToolEffects(altered, tool('Read'))).toEqual({ effects: unknown, independentReadCandidate: false })
    }
    expect(assessCapabilityToolEffects(d, { ...tool('Read') })).toEqual({ effects: unknown, independentReadCandidate: false })
  })
})
