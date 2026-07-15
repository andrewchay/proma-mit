/**
 * Agent Runtime 附件富化单元测试
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import type { FileAttachment } from '@proma/shared'

mock.module('electron', () => ({
  BrowserWindow: class MockBrowserWindow {},
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
  },
}))

const { enrichMessageWithDocuments, enrichHistoryWithDocuments, getImageAttachmentData } = await import('./attachment-enrichment')

describe('附件富化', () => {
  beforeEach(() => {
    mock.module('../document-parser', () => ({
      isDocumentAttachment: (mediaType: string) => mediaType === 'text/plain' || mediaType === 'application/pdf',
      extractTextFromAttachment: async (localPath: string) => {
        if (localPath.includes('empty')) return ''
        if (localPath.includes('error')) throw new Error('提取失败')
        return `内容：${localPath}`
      },
    }))

    mock.module('../attachment-service', () => ({
      isImageAttachment: (mediaType: string) => mediaType.startsWith('image/'),
      readAttachmentAsBase64: (localPath: string) => `base64:${localPath}`,
    }))
  })

  test('enrichMessageWithDocuments 无附件时返回原文', async () => {
    const result = await enrichMessageWithDocuments('你好', undefined)
    expect(result).toBe('你好')
  })

  test('enrichMessageWithDocuments 仅图片附件时返回原文', async () => {
    const attachments: FileAttachment[] = [
      { id: '1', filename: 'a.png', mediaType: 'image/png', size: 100, localPath: 's1/a.png' },
    ]
    const result = await enrichMessageWithDocuments('你好', attachments)
    expect(result).toBe('你好')
  })

  test('enrichMessageWithDocuments 提取文档附件文本并包裹 file 标签', async () => {
    const attachments: FileAttachment[] = [
      { id: '1', filename: 'note.txt', mediaType: 'text/plain', size: 100, localPath: 's1/note.txt' },
    ]
    const result = await enrichMessageWithDocuments('请查看', attachments)
    expect(result).toContain('请查看')
    expect(result).toContain('<file name="note.txt">')
    expect(result).toContain('内容：s1/note.txt')
    expect(result).toContain('</file>')
  })

  test('enrichMessageWithDocuments 混合图片和文档时只处理文档', async () => {
    const attachments: FileAttachment[] = [
      { id: '1', filename: 'a.png', mediaType: 'image/png', size: 100, localPath: 's1/a.png' },
      { id: '2', filename: 'note.txt', mediaType: 'text/plain', size: 100, localPath: 's1/note.txt' },
    ]
    const result = await enrichMessageWithDocuments('请查看', attachments)
    expect(result).toContain('<file name="note.txt">')
    expect(result).not.toContain('a.png')
  })

  test('enrichMessageWithDocuments 空文档显示占位符', async () => {
    const attachments: FileAttachment[] = [
      { id: '1', filename: 'empty.txt', mediaType: 'text/plain', size: 0, localPath: 's1/empty.txt' },
    ]
    const result = await enrichMessageWithDocuments('请查看', attachments)
    expect(result).toContain('[文件内容为空]')
  })

  test('enrichMessageWithDocuments 文档提取失败时显示错误占位符', async () => {
    const attachments: FileAttachment[] = [
      { id: '1', filename: 'error.txt', mediaType: 'text/plain', size: 0, localPath: 's1/error.txt' },
    ]
    const result = await enrichMessageWithDocuments('请查看', attachments)
    expect(result).toContain('[文档提取失败: 提取失败]')
  })

  test('enrichMessageWithDocuments 对文件名做 XML 属性转义', async () => {
    const attachments: FileAttachment[] = [
      { id: '1', filename: 'evil"<>&.txt', mediaType: 'text/plain', size: 100, localPath: 's1/evil.txt' },
    ]
    const result = await enrichMessageWithDocuments('请查看', attachments)
    expect(result).toContain('<file name="evil&quot;&lt;&gt;&amp;.txt">')
    expect(result).not.toContain('name="evil"<>&.txt"')
  })

  test('enrichMessageWithDocuments 对文档内容做 XML 文本转义', async () => {
    mock.module('../document-parser', () => ({
      isDocumentAttachment: (mediaType: string) => mediaType === 'text/plain',
      extractTextFromAttachment: async () => '内容含 </file> 与 <script> & "',
    }))
    const attachments: FileAttachment[] = [
      { id: '1', filename: 'note.txt', mediaType: 'text/plain', size: 100, localPath: 's1/note.txt' },
    ]
    const result = await enrichMessageWithDocuments('请查看', attachments)
    expect(result).toContain('内容含 &lt;/file&gt; 与 &lt;script&gt; &amp; "')
  })

  test('enrichHistoryWithDocuments 只处理含文档的用户消息', async () => {
    const history = [
      { id: 'u1', role: 'user' as const, content: '看文件', createdAt: 1, attachments: [{ id: '1', filename: 'note.txt', mediaType: 'text/plain', size: 100, localPath: 's1/note.txt' }] },
      { id: 'a1', role: 'assistant' as const, content: '好的', createdAt: 2 },
      { id: 'u2', role: 'user' as const, content: '看图片', createdAt: 3, attachments: [{ id: '2', filename: 'a.png', mediaType: 'image/png', size: 100, localPath: 's1/a.png' }] },
    ]
    const enriched = await enrichHistoryWithDocuments(history)
    expect(enriched[0]?.content).toContain('<file name="note.txt">')
    expect(enriched[1]?.content).toBe('好的')
    expect(enriched[2]?.content).toBe('看图片')
  })

  test('getImageAttachmentData 只返回图片附件的 base64 数据', () => {
    const attachments: FileAttachment[] = [
      { id: '1', filename: 'a.png', mediaType: 'image/png', size: 100, localPath: 's1/a.png' },
      { id: '2', filename: 'note.txt', mediaType: 'text/plain', size: 100, localPath: 's1/note.txt' },
    ]
    const result = getImageAttachmentData(attachments)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ mediaType: 'image/png', data: 'base64:s1/a.png' })
  })

  test('getImageAttachmentData 空附件返回空数组', () => {
    expect(getImageAttachmentData(undefined)).toEqual([])
    expect(getImageAttachmentData([])).toEqual([])
  })
})
