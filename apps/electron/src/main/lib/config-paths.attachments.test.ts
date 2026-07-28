import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const {
  getConversationAttachmentsDir,
  resolvePathWithinDirectory,
} = await import('./config-paths')

describe('附件路径边界', () => {
  test('当附件路径位于附件根目录内时，解析为该目录下的绝对路径', () => {
    const root = '/tmp/proma-attachment-root'
    expect(resolvePathWithinDirectory(root, 'conversation-1/file.txt', '附件路径')).toBe(join(root, 'conversation-1/file.txt'))
  })

  test('当附件路径试图穿越根目录时，拒绝解析', () => {
    expect(() => resolvePathWithinDirectory('/tmp/proma-attachment-root', '../settings.json', '附件路径')).toThrow('附件路径不在安全目录内')
  })

  test('当对话 ID 含路径分隔符时，拒绝创建附件目录', () => {
    expect(() => getConversationAttachmentsDir('../outside')).toThrow('附件对话 ID 必须是单个安全路径段')
  })
})
