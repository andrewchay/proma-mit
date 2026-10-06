import { describe, expect, test } from 'bun:test'
import type { CapabilityDescriptor, PermissionRequest } from '@gravitas/shared'
import { projectCapabilitySchemas } from '@gravitas/shared'
import { AgentPermissionService, type CanUseToolOptions } from '../../agent-permission-service'

/**
 * M4-03 集成验收：按需投影出的工具，真正执行时必须仍经 permission service。
 * 投影只解决「schema 何时进入 prompt」，绝不绕过权限判断。
 */

function options(): CanUseToolOptions {
  return { signal: new AbortController().signal, toolUseID: 'm4-integration' }
}

const catalog = {
  version: 1 as const,
  descriptors: [
    {
      version: 1,
      id: 'builtin:read',
      name: 'Read',
      summary: '读取文件',
      source: 'builtin',
      schemaRef: 'builtin:read:schema',
      access: 'read',
      dataClasses: ['workspace'],
      confirmation: 'never',
      parallelSafe: true,
    },
    {
      version: 1,
      id: 'builtin:app-write',
      name: 'AppWrite',
      summary: '向应用目录写入内容',
      source: 'builtin',
      schemaRef: 'builtin:app-write:schema',
      access: 'write',
      dataClasses: ['workspace'],
      confirmation: 'always',
      parallelSafe: false,
    },
  ] as CapabilityDescriptor[],
}

const schemas: Record<string, unknown> = {
  'builtin:read:schema': { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  'builtin:app-write:schema': { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
}

describe('M4-03 projected capability execution stays behind the permission service', () => {
  test('given safe mode when executing projected tools then writes are denied and reads allowed', async () => {
    const projection = projectCapabilitySchemas({
      catalog,
      selectedIds: ['builtin:read', 'builtin:app-write'],
      resolveSchema: (schemaRef) => schemas[schemaRef],
    })
    expect(projection.selected).toHaveLength(2)

    // 投影产出的工具名进入与 builtin 完全相同的权限链路
    const projectedToolNames = projection.selected.map((entry) => entry.descriptor.name)
    expect(projectedToolNames).toEqual(['Read', 'AppWrite'])

    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('m4-session', (request) => requests.push(request), undefined, undefined, 'safe')

    const readResult = await canUseTool('Read', { file_path: 'README.md' }, options())
    expect(readResult.behavior).toBe('allow')

    const writeResult = await canUseTool('AppWrite', { path: 'docs/a.md', content: 'x' }, options())
    expect(writeResult.behavior).toBe('deny')
    expect(requests).toHaveLength(0)
  })

  test('given auto mode when executing a projected write then it still requires the normal approval path', async () => {
    const projection = projectCapabilitySchemas({
      catalog,
      selectedIds: ['builtin:app-write'],
      resolveSchema: (schemaRef) => schemas[schemaRef],
    })

    const service = new AgentPermissionService()
    const requests: PermissionRequest[] = []
    const canUseTool = service.createCanUseTool('m4-session-auto', (request) => requests.push(request), undefined, undefined, 'auto')

    // classifierApprovable=false：投影不提供任何“免审批”信号，写入必须回到审批流程。
    // canUseTool 在 auto 模式下会挂起等待用户响应，因此不能直接 await。
    const pending = canUseTool('AppWrite', { path: 'docs/a.md', content: 'x' }, { ...options(), classifierApprovable: false })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests.length).toBeGreaterThan(0)
    const requestId = requests[0]!.requestId
    expect(service.respondToPermission(requestId, 'deny', false)).toBe('m4-session-auto')
    const result = await pending
    expect(result.behavior).toBe('deny')
    expect(projection.selected[0]!.schema).toEqual(schemas['builtin:app-write:schema'])
  })
})
