/**
 * Agent Runtime 附件富化
 *
 * 负责将图片附件读取为 base64、将文档附件提取为文本，
 * 供 Provider-Agnostic Agent Runtime 注入到 prompt 和历史消息中。
 *
 * 本模块依赖 Electron 主进程能力（文件对话框、附件路径解析），
 * 因此从 prompt-builder.ts 中拆出，避免纯 prompt 单元测试加载 electron。
 */

import type { ChatMessage, FileAttachment } from '@proma/shared'
import type { ImageAttachmentData } from '@proma/core'
import { readAttachmentAsBase64, isImageAttachment } from '../attachment-service'
import { extractTextFromAttachment, isDocumentAttachment } from '../document-parser'

/**
 * 从附件列表读取图片数据
 *
 * 作为 ImageAttachmentReader 注入给 core 层 ProviderAdapter。
 */
export function getImageAttachmentData(attachments?: FileAttachment[]): ImageAttachmentData[] {
  if (!attachments || attachments.length === 0) return []

  return attachments
    .filter((att) => isImageAttachment(att.mediaType))
    .map((att) => ({
      mediaType: att.mediaType,
      data: readAttachmentAsBase64(att.localPath),
    }))
}

/** XML 属性转义：防止文件名破坏 <file name="..."> 结构 */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** XML 文本内容转义：防止文档内容误闭合外层标签 */
function escapeXmlContent(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function extractDocumentText(localPath: string, filename: string): Promise<string> {
  try {
    const text = await extractTextFromAttachment(localPath)
    return text.trim() || '[文件内容为空]'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `[文档提取失败: ${message}]`
  }
}

/**
 * 将文档附件文本提取后追加到消息文本中
 *
 * 图片附件由 ProviderAdapter 单独处理，这里只处理文档类附件。
 */
export async function enrichMessageWithDocuments(
  messageText: string,
  attachments?: FileAttachment[],
): Promise<string> {
  if (!attachments || attachments.length === 0) return messageText

  const docAttachments = attachments.filter((att) => isDocumentAttachment(att.mediaType))
  if (docAttachments.length === 0) return messageText

  const parts: string[] = [messageText]
  for (const att of docAttachments) {
    const text = await extractDocumentText(att.localPath, att.filename)
    parts.push(`\n<file name="${escapeXmlAttribute(att.filename)}">\n${escapeXmlContent(text)}\n</file>`)
  }
  return parts.join('')
}

/**
 * 批量为历史消息提取文档附件文本
 */
export async function enrichHistoryWithDocuments(history: ChatMessage[]): Promise<ChatMessage[]> {
  const enriched: import('@proma/shared').ChatMessage[] = []
  for (const msg of history) {
    if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
      const hasDocuments = msg.attachments.some((att) => isDocumentAttachment(att.mediaType))
      if (hasDocuments) {
        const enrichedContent = await enrichMessageWithDocuments(msg.content, msg.attachments)
        enriched.push({ ...msg, content: enrichedContent })
        continue
      }
    }
    enriched.push(msg)
  }
  return enriched
}
