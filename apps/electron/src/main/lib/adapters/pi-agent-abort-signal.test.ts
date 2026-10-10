/**
 * Pi Agent 适配器：调用方 abortSignal 必须终止进行中的 prompt 链（HR09）。
 *
 * 复现真实缺陷：abortSignal 此前仅在压缩路径（runWithCompactionAbort）生效，
 * 主 prompt 执行链从不监听调用方中止信号，导致中止后会话仍继续发起工具调用。
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testDir = mkdtempSync(join(tmpdir(), 'gravitas-pi-abort-'))
process.env.PROMA_TEST_CONFIG_DIR = testDir
const store = await import('../project-sqlite-store')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(testDir, { recursive: true, force: true })
})

import { buildElectronMock } from '../testing/electron-mock'

mock.module('electron', () => buildElectronMock())
mock.module('../attachment-service', () => ({
  isImageAttachment: () => false,
  readAttachmentAsBase64: () => '',
  deleteAttachment: () => {},
  deleteConversationAttachments: () => {},
  saveAttachment: async () => ({ path: '/tmp/mock', fileName: 'mock', mimeType: 'text/plain', size: 0 }),
  openFileDialog: async () => null,
}))
mock.module('../document-parser', () => ({
  isDocumentAttachment: () => false,
  extractTextFromAttachment: async () => '',
}))

let promptCalls = 0
let sessionAbortCalls = 0
let pendingReject: ((error: Error) => void) | undefined
let streaming = false

function makeAbortError(): Error {
  const error = new Error('操作已中止')
  error.name = 'AbortError'
  return error
}

mock.module('./pi-sdk-loader', () => ({
  loadPiCodingAgent: async () => ({
    DefaultResourceLoader: class {
      async reload(): Promise<void> {}
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({
      session: {
        state: { messages: [] },
        agent: { toolExecution: 'sequential' },
        subscribe: () => () => {},
        async prompt() {
          promptCalls += 1
          streaming = true
          try {
            // 挂起的 Provider 往返：只有 abort() 能解除。
            await new Promise<void>((_resolve, reject) => { pendingReject = reject })
          } finally {
            streaming = false
          }
        },
        get isStreaming() {
          return streaming
        },
        async steer() {},
        async followUp() {},
        async abort() {
          sessionAbortCalls += 1
          pendingReject?.(makeAbortError())
        },
        dispose() {},
      },
    }),
  }),
}))

mock.module('./pi-model-registry', () => ({
  registerPiModelFromChannel: async () => ({
    agentDir: '/tmp/pi-agent',
    modelRuntime: {},
    providerId: 'proma-test',
    model: { contextWindow: 1_000_000 },
  }),
}))

const { PiAgentAdapter } = await import('./pi-agent-adapter')
type PilotQueryOptions = import('./pi-agent-adapter').PiAgentQueryOptions

function queryOptions(sessionId: string, controller: AbortController): PilotQueryOptions {
  return {
    sessionId,
    prompt: '探针',
    agentRuntime: 'pi',
    provider: 'deepseek',
    apiKey: 'key',
    baseUrl: 'https://example.test',
    model: 'deepseek-flash',
    cwd: testDir,
    permissionMode: 'bypassPermissions',
    abortSignal: controller.signal,
  }
}

describe('Pi 适配器调用方 abortSignal（HR09）', () => {
  test('进行中的 prompt 链在调用方中止时终止：会话被 abort、迭代以 AbortError 结束', async () => {
    const adapter = new PiAgentAdapter()
    const controller = new AbortController()
    const iterator = adapter.query(queryOptions('abort-mid-flight', controller))[Symbol.asyncIterator]()
    const first = iterator.next()
    // 等 prompt 进入挂起状态。
    await new Promise((r) => setTimeout(r, 50))
    expect(promptCalls).toBe(1)
    controller.abort()
    // 当前缺陷：abortSignal 未接入主链，迭代会永久挂起；用看门狗把"挂起"判为失败。
    const outcome = await Promise.race([
      first.then(() => 'resolved' as const).catch((error: unknown) => ({ error })),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ])
    expect(outcome).not.toBe('hung')
    expect(sessionAbortCalls).toBe(1)
    const err = typeof outcome === 'object' && outcome !== null && 'error' in outcome ? outcome.error : undefined
    expect(err).toBeDefined()
    expect((err as Error).name).toBe('AbortError')
  })

  test('已中止的信号在查询开始前即 fail-fast，不发起 Provider 请求', async () => {
    const adapter = new PiAgentAdapter()
    const controller = new AbortController()
    controller.abort()
    const before = promptCalls
    const iterator = adapter.query(queryOptions('abort-pre-aborted', controller))[Symbol.asyncIterator]()
    const outcome = await Promise.race([
      iterator.next().then(() => 'resolved' as const).catch((error: unknown) => ({ error })),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ])
    expect(outcome).not.toBe('hung')
    expect(promptCalls).toBe(before)
  })
})
