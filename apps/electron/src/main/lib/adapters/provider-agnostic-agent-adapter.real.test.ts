/**
 * Provider-Agnostic Agent 适配器真实 API 集成测试（临时）
 *
 * 需要环境变量 DEEPSEEK_API_KEY。未设置时跳过。
 * 请勿提交 API key，运行后可删除本文件。
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  BrowserWindow: class MockBrowserWindow {},
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
  },
}))

mock.module('../attachment-service', () => ({
  isImageAttachment: (mediaType: string) => mediaType.startsWith('image/'),
  readAttachmentAsBase64: (localPath: string) => `base64:${localPath}`,
}))
mock.module('../document-parser', () => ({
  isDocumentAttachment: (mediaType: string) => mediaType === 'text/plain',
  extractTextFromAttachment: async (localPath: string) => `文档内容：${localPath}`,
}))

const { ProviderAgnosticAgentAdapter } = await import('./provider-agnostic-agent-adapter')

const apiKey = process.env.DEEPSEEK_API_KEY
const shouldRun = Boolean(apiKey)

;(shouldRun ? describe : describe.skip)('Provider-Agnostic Agent 真实 API', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-paa-real-'))
  })

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  test('DeepSeek 真实工具循环：写文件并返回结果', async () => {
    const adapter = new ProviderAgnosticAgentAdapter()
    const sessionId = `real-${Date.now()}`
    const stream = adapter.query({
      sessionId,
      prompt: '在 note.txt 文件中写入 "hello deepseek"，然后告诉我完成了吗？',
      model: 'deepseek-chat',
      provider: 'openai',
      apiKey: apiKey!,
      baseUrl: 'https://api.deepseek.com',
      cwd: tempDir,
      permissionMode: 'bypassPermissions',
      maxTurns: 5,
      systemPrompt: '你是一个可以使用文件工具的助手。当用户要求你写文件时，请调用 Write 工具。',
    })

    const messages: unknown[] = []
    for await (const msg of stream) {
      messages.push(msg)
    }

    const result = messages.find((m) => (m as { type?: string }).type === 'result')
    expect(result).toBeDefined()
    expect((result as { subtype?: string }).subtype).toBe('success')

    const usage = (result as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage
    expect(usage).toBeDefined()
    expect((usage?.input_tokens ?? 0) > 0).toBe(true)
    expect((usage?.output_tokens ?? 0) > 0).toBe(true)

    const content = readFileSync(join(tempDir, 'note.txt'), 'utf-8')
    expect(content).toContain('hello deepseek')
  }, 60_000)
})
