/**
 * 知识分块器（K1-03）
 *
 * 把一个文档切成可检索、可定位的片段。
 *
 * 设计取舍：
 *
 * - **按 Markdown 标题与段落切分，不按固定字符数硬切**。硬切会把一句话劈成
 *   两半，检索出半句证据；按语义边界切分让引用能被人读懂。
 * - **保留字符区间**。原文是权威来源，引用必须能回到原位置。这里用
 *   charStart/charEnd 记录片段在正文中的偏移，供 UI 定位。
 * - **超长段落再按句子收尾切分**，避免单个 chunk 超过可检索长度上限。
 *
 * 纯函数，无 IO：分块结果由索引服务负责落库。
 */

/** 单个 chunk 的目标上限（字符）。超过则按句子边界继续切分。 */
export const MAX_CHUNK_CHARS = 1200

/** 低于该长度的尾部片段会并入前一个 chunk，避免产生大量碎片 */
const MIN_CHUNK_CHARS = 80

export interface DocumentChunk {
  chunkIndex: number
  heading?: string
  content: string
  charStart: number
  charEnd: number
}

interface Section {
  heading?: string
  body: string
  /** 该 section 正文在全文中的起始偏移 */
  offset: number
}

/**
 * 按 Markdown 标题切分 section。
 *
 * 标题层级不参与合并：`##` 与 `###` 都作为独立边界，因为小节的检索语义
 * 通常由其最近标题决定。
 */
function splitSections(text: string): Section[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  let currentHeading: string | undefined
  let buffer: string[] = []
  let offset = 0
  let bufferStart = 0

  const flush = (): void => {
    const body = buffer.join('\n')
    if (body.trim() !== '' || currentHeading !== undefined) {
      sections.push({ heading: currentHeading, body, offset: bufferStart })
    }
    buffer = []
  }

  for (const line of lines) {
    const lineLength = line.length + 1 // 含换行符
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line)

    if (headingMatch) {
      flush()
      currentHeading = headingMatch[2]!.trim()
      bufferStart = offset + lineLength
      offset += lineLength
      continue
    }

    if (buffer.length === 0) bufferStart = offset
    buffer.push(line)
    offset += lineLength
  }
  flush()

  return sections
}

/** 按句子边界切分超长文本，保留每段的相对偏移 */
function splitLongBody(body: string, baseOffset: number): Array<{ text: string; offset: number }> {
  if (body.length <= MAX_CHUNK_CHARS) return [{ text: body, offset: baseOffset }]

  const parts: Array<{ text: string; offset: number }> = []
  // 在中文/英文句末标点后切分；没有标点时退化为固定长度切分
  const sentenceEnd = /[。！？.!?]\s*/g
  let cursor = 0

  while (cursor < body.length) {
    let end = Math.min(cursor + MAX_CHUNK_CHARS, body.length)
    if (end < body.length) {
      // 在窗口内找最后一个句末标点
      sentenceEnd.lastIndex = cursor
      let lastBoundary = -1
      let match: RegExpExecArray | null
      while ((match = sentenceEnd.exec(body)) !== null) {
        if (match.index >= end) break
        lastBoundary = match.index + match[0].length
      }
      if (lastBoundary > cursor + MIN_CHUNK_CHARS) end = lastBoundary
    }

    parts.push({ text: body.slice(cursor, end), offset: baseOffset + cursor })
    cursor = end
  }

  return parts
}

/**
 * 分块主入口。
 *
 * 返回的 charStart/charEnd 是相对于传入全文的偏移，调用方应把同一份全文
 * （而不是处理后文本）作为定位基准。
 */
export function chunkDocument(content: string): DocumentChunk[] {
  const sections = splitSections(content)
  const chunks: DocumentChunk[] = []

  for (const section of sections) {
    const body = section.body.trim()
    if (body === '' && section.heading === undefined) continue

    const pieces = body === '' ? [{ text: section.heading ?? '', offset: section.offset }] : splitLongBody(body, section.offset)

    for (const piece of pieces) {
      const text = piece.text.trim()
      if (text === '') continue
      const start = content.indexOf(text, piece.offset >= 0 ? piece.offset : 0)
      const charStart = start >= 0 ? start : piece.offset
      chunks.push({
        chunkIndex: chunks.length,
        heading: section.heading,
        content: text,
        charStart,
        charEnd: charStart + text.length,
      })
    }
  }

  // 空文档至少保留一个可检索的空块，避免文档存在但完全搜不到
  if (chunks.length === 0 && content.trim() !== '') {
    chunks.push({ chunkIndex: 0, content: content.trim(), charStart: 0, charEnd: content.trim().length })
  }

  return chunks
}
