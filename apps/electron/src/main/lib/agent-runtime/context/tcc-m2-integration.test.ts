import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextItem } from '@gravitas/shared'
import { isTypedContextCompilerEnabled } from './context-feature-flag'
import { ContextLedgerStore } from './context-ledger'
import { SubtaskArtifactStore, toStoredSubtaskArtifact } from './subtask-artifact-store'
import { formatSubtaskResultForParent, parseSubtaskResult } from './subtask-result-parser'
import { buildSubAgentSpawnPlan } from './subagent-spawn-plan'

const PRIVATE_LOCATOR = 'secrets/tcc-m2/private.txt'

function item(overrides: Partial<ContextItem> & Pick<ContextItem, 'id'>): ContextItem {
  return {
    kind: 'file_fact',
    version: 1,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    content: `事实内容 ${overrides.id}`,
    tags: ['fixture'],
    visibility: 'parent',
    mutability: 'append_only',
    confidence: 'high',
    source: { kind: 'file_locator', id: overrides.id, sessionId: 'parent-1' },
    evidence: [{ kind: 'file_locator', sourceId: overrides.id, locator: `docs/${overrides.id}.md`, verified: true }],
    ...overrides,
  }
}

/** 用真实 ContextLedgerStore 落盘，避免验收绕过生产读取路径。 */
function seedWorkspace(directory: string): void {
  const ledger = new ContextLedgerStore(join(directory, 'context'))
  ledger.append(item({ id: 'fact-public-1', kind: 'file_fact', tags: ['required'] }))
  ledger.append(item({ id: 'constraint-1', kind: 'constraint', tags: ['required'] }))
  ledger.append(item({ id: 'noise-1', kind: 'tool_observation', confidence: 'low', tags: ['noise'], content: '无关工具输出' }))
  ledger.append(item({ id: 'private-1', kind: 'artifact', visibility: 'private', tags: ['sensitive'], content: '绝不可投影的凭据', evidence: [{ kind: 'file_locator', sourceId: 'private-1', locator: PRIVATE_LOCATOR, verified: true }] }))
}

function planFor(directory: string, options: { typedContextEnabled: boolean; agentName?: string; withWorkspace?: boolean }) {
  return buildSubAgentSpawnPlan({
    parentSessionId: 'parent-1',
    parentCwd: '/parent/cwd',
    parentPermissionMode: 'bypassPermissions',
    typedContextEnabled: options.typedContextEnabled,
    workspaceDirectory: options.withWorkspace === false ? undefined : directory,
    childWorkspaceDirectory: join(directory, 'child-session'),
    subAgent: { agentName: options.agentName ?? 'explorer', task: '核验事实并给出结论', maxTurns: 1 },
  })
}

const TYPED_RESPONSE = `\`\`\`json
${JSON.stringify({
  protocolVersion: 1,
  status: 'completed',
  summary: '核验完成',
  claims: [{ statement: '事实成立', confidence: 'high', verified: true, evidence: [{ kind: 'file_locator', sourceId: 'fact-public-1', verified: true }] }],
  artifacts: [],
  unverified: [],
  recommendedNextSteps: [],
})}
\`\`\``

describe('TCC M2 集成验收', () => {
  test('given the flag is off then spawn keeps the legacy baseline untouched', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tcc-m2-'))
    try {
      seedWorkspace(directory)
      const plan = planFor(directory, { typedContextEnabled: false })

      expect(plan.projection).toBeUndefined()
      expect(plan.typedResultEnabled).toBe(false)
      expect(plan.childCwd).toBe('/parent/cwd')
      // 父会话即使处于 bypassPermissions，基线也不应被改写
      expect(plan.permissionMode).toBe('bypassPermissions')
      expect(plan.prompt).not.toContain('Typed Context Projection')
      expect(plan.subAgent.context).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('given the flag is on then projection, read-only isolation and typed handoff are all active', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tcc-m2-'))
    try {
      seedWorkspace(directory)
      const plan = planFor(directory, { typedContextEnabled: true })

      // projection：经真实 ledger 读取，且私密项与低置信噪声不进入
      expect(plan.projection).toBeDefined()
      const selected = plan.projection!.items.map((entry) => entry.itemId)
      expect(selected).toContain('fact-public-1')
      expect(selected).not.toContain('private-1')
      expect(plan.prompt).toContain('Typed Context Projection')
      expect(plan.prompt).not.toContain('绝不可投影的凭据')
      expect(plan.prompt).toContain('typed-v1')

      // 只读隔离：私有 cwd + safe，且父会话的 bypassPermissions 不能覆盖
      expect(plan.childCwd).toBe(join(directory, 'child-session'))
      expect(plan.permissionMode).toBe('safe')
      expect(plan.subAgent.context?.readOnly).toBe(true)

      // typed handoff：父 Agent 只拿到结构化摘要，不含 raw transcript
      expect(plan.typedResultEnabled).toBe(true)
      const parsed = parseSubtaskResult(TYPED_RESPONSE, 'parent-1:child-1')
      expect(parsed.protocolError).toBeUndefined()
      const handoff = formatSubtaskResultForParent(parsed.result)
      expect(handoff).toContain('核验完成')
      expect(handoff).toContain('file_locator:fact-public-1')
      expect(handoff).not.toContain('protocolVersion')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('given session override then it wins over the workspace setting and fails closed by default', () => {
    expect(isTypedContextCompilerEnabled({ workspaceEnabled: true, sessionEnabled: false })).toBe(false)
    expect(isTypedContextCompilerEnabled({ workspaceEnabled: false, sessionEnabled: true })).toBe(true)
    expect(isTypedContextCompilerEnabled({ workspaceEnabled: true })).toBe(true)
    expect(isTypedContextCompilerEnabled({})).toBe(false)
  })

  test('given a projection failure then the spawn falls back to baseline instead of a half-built isolation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tcc-m2-'))
    try {
      const plan = planFor(directory, { typedContextEnabled: true, withWorkspace: false })

      expect(plan.projection).toBeUndefined()
      expect(plan.projectionFallbackReason).toBe('workspace ledger unavailable')
      expect(plan.typedResultEnabled).toBe(false)
      expect(plan.childCwd).toBe('/parent/cwd')
      expect(plan.permissionMode).toBe('bypassPermissions')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('given an opted-in spawn then the private artifact keeps the raw transcript and survives a reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tcc-m2-'))
    try {
      seedWorkspace(directory)
      const plan = planFor(directory, { typedContextEnabled: true })
      const parsed = parseSubtaskResult(TYPED_RESPONSE, 'parent-1:child-1')
      const store = new SubtaskArtifactStore(join(directory, 'context', 'subtasks'))
      store.save(toStoredSubtaskArtifact({
        childSessionId: 'child-1',
        parentSessionId: 'parent-1',
        task: plan.subAgent.task,
        rawResponse: TYPED_RESPONSE,
        result: parsed.result,
        projection: plan.projection!,
      }))

      const reopened = new SubtaskArtifactStore(join(directory, 'context', 'subtasks')).get('child-1')
      expect(reopened?.rawResponse).toContain('protocolVersion')
      expect(reopened?.result.summary).toBe('核验完成')
      expect(reopened?.projection.sourceItemIds).not.toContain('private-1')
      // 产物目录是工作区私有路径，不在父会话 cwd 下
      expect(join(directory, 'context', 'subtasks')).not.toContain('/parent/cwd')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('given a non-pilot agent then the flag alone does not opt it into TCC', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tcc-m2-'))
    try {
      seedWorkspace(directory)
      const plan = planFor(directory, { typedContextEnabled: true, agentName: 'custom-agent' })

      expect(plan.projection).toBeUndefined()
      expect(plan.typedResultEnabled).toBe(false)
      expect(plan.permissionMode).toBe('bypassPermissions')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
