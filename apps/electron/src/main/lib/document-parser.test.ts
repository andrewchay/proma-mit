/**
 * 文档解析服务单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'
import { extractTextFromAttachment, extractTextFromFile } from './document-parser'

describe('文档解析服务', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-doc-parser-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('extractTextFromFile 读取文本文件', async () => {
    const filePath = join(tempDir, 'note.txt')
    writeFileSync(filePath, 'hello world', 'utf-8')
    const text = await extractTextFromFile(filePath)
    expect(text).toBe('hello world')
  })

  test('extractTextFromAttachment 支持相对路径', async () => {
    // 模拟 Chat 附件相对路径：需要在 ~/.proma/attachments/ 下
    const configDir = getConfigDir()
    const conversationId = `test-conv-${Date.now()}`
    const attachmentDir = join(configDir, 'attachments', conversationId)
    mkdirSync(attachmentDir, { recursive: true })
    const filePath = join(attachmentDir, 'note.txt')
    writeFileSync(filePath, '相对路径内容', 'utf-8')

    const text = await extractTextFromAttachment(`${conversationId}/note.txt`)
    expect(text).toBe('相对路径内容')

    rmSync(attachmentDir, { recursive: true, force: true })
  })

  test('extractTextFromAttachment 支持 ~/.proma/ 下的绝对路径', async () => {
    const configDir = getConfigDir()
    const agentDir = join(configDir, 'agent-workspaces', 'test-ws', `test-session-${Date.now()}`)
    mkdirSync(agentDir, { recursive: true })
    const filePath = join(agentDir, 'note.txt')
    writeFileSync(filePath, '绝对路径内容', 'utf-8')

    const text = await extractTextFromAttachment(filePath)
    expect(text).toBe('绝对路径内容')

    rmSync(agentDir, { recursive: true, force: true })
  })

  test('extractTextFromAttachment 拒绝 ~/.proma/ 外的绝对路径', async () => {
    const filePath = join(tempDir, 'note.txt')
    writeFileSync(filePath, '越界内容', 'utf-8')

    await expect(extractTextFromAttachment(filePath)).rejects.toThrow('附件路径不在安全目录内')
  })
})
