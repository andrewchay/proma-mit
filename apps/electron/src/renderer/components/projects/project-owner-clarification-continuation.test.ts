import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { OwnerRuntimeBinding, ProjectOwnerGoalDraft, ProjectOwnerPlanDraft, ProjectOwnerPlanningContext, ProjectOwnerRunView } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from '@/atoms/project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '@/atoms/project-owner-plan-atoms'
import { getOwnerRuntimeEditor, ownerRuntimeApiAtom, ownerRuntimeEditorsAtom } from '@/atoms/project-owner-runtime-atoms'
import { resumeOwnerClarificationAfterSaveAtom } from './project-owner-clarification-continuation'

test('Given已保存的完整澄清答复 When续跑Atom执行 Then只创建一次暂停准备且不发送模型请求', async () => {
  const store = createStore(), subject = { projectId: 'p' }, key = '["p",null]'
  const questions = [{ key: 'audience', reasonType: 'missing_information' as const, question: '主要受众是谁？', why: '影响定位。', options: [] }]
  const goal: ProjectOwnerGoalDraft = { schemaVersion: 1, revision: 8, state: 'draft', actor: 'local-user', savedAt: 8, goal: { ...subject, goalVersion: 4, objective: '形成方案', constraints: ['Owner澄清答复（主要受众是谁？）：新用户'], acceptanceCriteria: [] } }
  const context: ProjectOwnerPlanningContext = { goal, fingerprint: 'new-context', sources: { project: { id: 'p', title: '项目', description: '' }, roles: [] } }
  const plan: ProjectOwnerPlanDraft = { ...subject, schemaVersion: 1, revision: 2, planVersion: 2, goalRevision: 7, goalVersion: 3, state: 'stale', actor: 'local-user', origin: 'manual', savedAt: 7, changeReason: '旧目标计划', contextFingerprint: 'old-context', planFingerprint: 'old-plan', sources: { project: { id: 'p', title: '项目', description: '' }, roles: [] }, proposal: { ...subject, goalVersion: 3, mode: 'proposal_only', summary: '旧计划', assumptions: [], risks: [], steps: [] } }
  const binding: OwnerRuntimeBinding = { schemaVersion: 1, projectId: 'p', revision: 5, ownerRole: 'project_owner', ownerName: 'Owner', carrierId: 'carrier', workspaceId: 'workspace', channelId: 'channel', modelId: 'model', runtime: 'ai-sdk', carrierFingerprint: 'carrier-fingerprint', actor: 'local-user', savedAt: 1, changeReason: '配置' }
  const oldRun: ProjectOwnerRunView = {
    link: { schemaVersion: 1, id: 'old-link', projectId: 'p', requestId: 'old-request', planningTaskId: 'old-task', bindingRevision: 5, goalRevision: 7, goalVersion: 3, planRevision: 2, contextFingerprint: 'old-context', carrierFingerprint: 'carrier-fingerprint', protocolVersion: '1', promptHash: 'old-prompt', purpose: 'owner_planning', maxRequests: 1, maxOutputTokens: 4096, createdAt: 1 },
    executions: [{ id: 'old-execution', sessionId: 'old-session', status: 'completed', summary: 'need clarification' }], receipts: [],
    outcomes: [{ executionId: 'old-execution', receiptId: 'old-receipt', state: 'needs_clarification', detail: '需澄清', clarification: { projectId: 'p', goalVersion: 3, contextFingerprint: 'old-context', reason: '需澄清', questions } }],
  }
  store.set(ownerGoalEditorsAtom, new Map([[key, { ...getOwnerGoalEditor(new Map(), subject), snapshot: goal, loaded: true }]]))
  store.set(ownerPlanEditorsAtom, new Map([[key, { ...getOwnerPlanEditor(new Map(), subject), snapshot: plan, context, loaded: true }]]))
  store.set(ownerRuntimeEditorsAtom, new Map([[key, { ...getOwnerRuntimeEditor(new Map(), subject), binding, context, runs: [oldRun] }]]))
  let prepareCalls = 0
  let runs = [oldRun]
  store.set(ownerRuntimeApiAtom, {
    getOwnerRuntimeBinding: async () => ({ ok: true as const, value: binding }),
    ensureOwnerRuntimeBinding: async () => ({ ok: true as const, value: binding }),
    saveOwnerRuntimeBinding: async () => ({ ok: true as const, value: binding }),
    prepareOwnerPlanning: async request => {
      prepareCalls++
      const link: ProjectOwnerRunView['link'] = { schemaVersion: 1, id: 'new-link', projectId: 'p', requestId: request.input.requestId, planningTaskId: 'new-task', bindingRevision: 5, goalRevision: 8, goalVersion: 4, planRevision: 2, contextFingerprint: 'new-context', carrierFingerprint: 'carrier-fingerprint', protocolVersion: '2', promptHash: 'new-prompt', purpose: 'owner_planning', maxRequests: 1, maxOutputTokens: 8192, createdAt: 2 }
      runs = [{ link, executions: [], receipts: [], outcomes: [] }, ...runs]
      return { ok: true as const, value: link }
    },
    listOwnerPlanningRuns: async () => ({ ok: true as const, value: runs }),
    getOwnerPlanningContext: async () => ({ ok: true as const, value: context }),
    listEmployees: async () => [], listWorkspaces: async () => [], listWorkspaceBindings: async () => [],
  })

  const input = { ...subject, linkId: 'old-link', executionId: 'old-execution' }
  expect(await store.set(resumeOwnerClarificationAfterSaveAtom, input)).toBe(true)
  expect(await store.set(resumeOwnerClarificationAfterSaveAtom, input)).toBe(false)
  expect(prepareCalls).toBe(1)
  expect(getOwnerRuntimeEditor(store.get(ownerRuntimeEditorsAtom), subject).runs[0]?.link.id).toBe('new-link')
})
