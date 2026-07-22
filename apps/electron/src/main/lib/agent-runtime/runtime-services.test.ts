process.env.PROMA_DEV = '1'

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentStreamPayload, McpServerEntry, SDKMessage } from '@proma/shared'
import type { McpClientManager } from './mcp-client'
import { AgentEventBus } from '../agent-event-bus'

const originalTestConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const tempDir = mkdtempSync(join(tmpdir(), 'proma-runtime-services-test-'))
process.env.PROMA_TEST_CONFIG_DIR = tempDir

mock.module('electron', () => ({
  app: {
    getPath: () => tempDir,
  },
  BrowserWindow: class MockBrowserWindow {},
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (buf: Buffer) => buf.toString('utf-8'),
  },
  shell: { openExternal: () => {} },
}))

const { createElectronRuntimeServices } = await import('./runtime-services')
const { ElectronRuntimeMcpService } = await import('./runtime-mcp-service')

beforeEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterAll(() => {
  if (originalTestConfigDir === undefined) {
    delete process.env.PROMA_TEST_CONFIG_DIR
  } else {
    process.env.PROMA_TEST_CONFIG_DIR = originalTestConfigDir
  }
  rmSync(tempDir, { recursive: true, force: true })
})

describe('Agent runtime services', () => {
  test('given SDK messages when using session store then history can append and truncate', () => {
    const services = createElectronRuntimeServices(new AgentEventBus())
    const userMessage = {
      type: 'user',
      uuid: 'user-1',
      message: { content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    const assistantMessage = {
      type: 'assistant',
      uuid: 'assistant-1',
      message: { content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    services.sessions.appendMessages('session-1', [userMessage, assistantMessage])
    expect(services.sessions.getHistoryMessages('session-1').map((message) => message.type)).toEqual(['user', 'assistant'])

    const kept = services.sessions.truncateMessages('session-1', 'user-1')
    expect(kept.map((message) => message.type)).toEqual(['user'])
    expect(services.sessions.getHistoryMessages('session-1').map((message) => message.type)).toEqual(['user'])
  })

  test('given event payload when using event sink then payload is forwarded through event bus', () => {
    const eventBus = new AgentEventBus()
    const services = createElectronRuntimeServices(eventBus)
    const seen: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
    eventBus.on((sessionId, payload) => {
      seen.push({ sessionId, payload })
    })

    services.events.emit('session-1', {
      kind: 'agent_event',
      event: { type: 'text_delta', text: 'hello' },
    })

    expect(seen).toEqual([{
      sessionId: 'session-1',
      payload: {
        kind: 'agent_event',
        event: { type: 'text_delta', text: 'hello' },
      },
    }])
  })

  test('given MCP runtime service when acquiring manager then cache boundary receives workspace context', async () => {
    const manager = {
      connectAll: async () => {},
      listAllTools: async () => [],
      disconnect: async () => {},
    } as unknown as McpClientManager
    const release = mock(() => {})
    const acquire = mock(async (
      workspaceSlug: string,
      configs: Record<string, McpServerEntry>,
      cwd: string,
      options: { onMcpAuthRequired?: (payload: { workspaceSlug: string; serverName: string }) => void },
    ) => {
      options.onMcpAuthRequired?.({ workspaceSlug, serverName: 'fs' })
      return { manager, release }
    })
    const service = new ElectronRuntimeMcpService(acquire)
    const authEvents: Array<{ workspaceSlug: string; serverName: string }> = []

    const lease = await service.acquireClientManager({
      workspaceSlug: 'demo',
      mcpServers: { fs: { type: 'stdio', enabled: true, command: 'node', args: [] } },
      cwd: '/tmp/demo',
      onMcpAuthRequired: (payload) => authEvents.push(payload),
    })
    lease.release()

    expect(acquire).toHaveBeenCalledTimes(1)
    expect(acquire.mock.calls[0]?.[0]).toBe('demo')
    expect(acquire.mock.calls[0]?.[2]).toBe('/tmp/demo')
    expect(lease.manager).toBe(manager)
    expect(release).toHaveBeenCalledTimes(1)
    expect(authEvents).toEqual([{ workspaceSlug: 'demo', serverName: 'fs' }])
  })
})
