import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSendInput } from '@gravitas/shared'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-collaboration-stop-'))
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = join(directory, 'config')
mock.module('electron', () => buildElectronMock())

const { createChannel } = await import('./channel-manager')
const { createAgentSession, getAgentSessionMeta, updateAgentSessionMeta } = await import('./agent-session-manager')
const store = await import('./project-sqlite-store')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createCollaborationDelegations, stopDelegation } = await import('./agent-collaboration-tools')
const { setAgentStopper, setHeadlessAgentRunner } = await import('./agent-headless-runner-registry')

let activeRun: { input: AgentSendInput; callbacks: HeadlessAgentRunCallbacks } | undefined

beforeAll(async () => {
  await store.initProjectDb()
  setHeadlessAgentRunner(async (input, callbacks) => {
    activeRun = { input, callbacks }
  })
  setAgentStopper((sessionId, expectedGeneration) => ({
    sessionId,
    expectedGeneration,
    activeGeneration: expectedGeneration,
    requestAccepted: true,
    stopped: false,
    reason: 'stop-request-accepted',
    processTermination: 'NOT_VERIFIED',
  }))
})

afterAll(() => {
  store.closeProjectDb()
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})

describe('协作子会话停止真实性', () => {
  test('Given Runtime 只接受停止请求 When 停止委派 Then 不立即伪报 stopped/cancelled', () => {
    const channel = createChannel({
      name: '协作停止测试',
      provider: 'openai',
      baseUrl: 'https://example.invalid',
      apiKey: 'not-a-real-key',
      enabled: true,
      models: [{ id: 'model', name: 'model', enabled: true }],
    })
    const project = store.createProject({ title: '协作停止项目', description: '' })
    const workspace = createAgentWorkspace('协作停止工作区')
    const parent = createAgentSession('父会话', channel.id, workspace.id, 'model', 'pi')
    updateAgentSessionMeta(parent.id, { projectId: project.id })
    const created = createCollaborationDelegations(
      { sessionId: parent.id, channelId: channel.id, workspaceId: workspace.id, modelId: 'model', agentRuntime: 'pi', permissionMode: 'plan' },
      [{ title: '子任务', task: '执行一个等待停止的测试任务' }],
    )
    expect(created.failures).toEqual([])
    const delegation = created.delegations[0]!

    expect(stopDelegation(parent.id, delegation.delegationId)).toMatchObject({
      stopped: false,
      stopRequested: true,
      stopConfirmation: {
        requestAccepted: true,
        stopped: false,
        processTermination: 'NOT_VERIFIED',
      },
    })
    expect(getAgentSessionMeta(delegation.childSessionId)?.delegationStatus).toBe('running')

    activeRun?.callbacks.onComplete([], { stoppedByUser: true })
    expect(getAgentSessionMeta(delegation.childSessionId)?.delegationStatus).toBe('cancelled')
  })
})
