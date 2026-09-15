import { describe, expect, test } from 'bun:test'
import { chunkDocument, MAX_CHUNK_CHARS } from './chunking.ts'

/**
 * 知识分块测试（K1-03）。
 *
 * 分块是检索质量与引用可定位性的共同基础：切错会让证据缺半句，
 * 或让 charStart/charEnd 指向错误位置。
 */

describe('按标题与段落分块', () => {
  test('按 Markdown 标题切分为独立片段', () => {
    const doc = `# 标题\n\n第一节内容\n\n## 小节\n\n第二节内容\n`
    const chunks = chunkDocument(doc)

    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.some((c) => c.heading === '标题')).toBe(true)
    expect(chunks.some((c) => c.heading === '小节')).toBe(true)
  })

  test('每个片段携带最近标题', () => {
    const doc = `## 架构\n\n本地优先。\n\n## 权限\n\n范围校验。\n`
    const chunks = chunkDocument(doc)
    const arch = chunks.find((c) => c.content.includes('本地优先'))
    const perm = chunks.find((c) => c.content.includes('范围校验'))

    expect(arch?.heading).toBe('架构')
    expect(perm?.heading).toBe('权限')
  })

  test('chunkIndex 从 0 连续递增', () => {
    const doc = `# A\n\n甲\n\n# B\n\n乙\n\n# C\n\n丙\n`
    const chunks = chunkDocument(doc)
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i))
  })
})

describe('字符区间可定位', () => {
  test('charStart/charEnd 指向原文中的真实位置', () => {
    const doc = `# 标题\n\n第一段内容\n\n第二段内容\n`
    const chunks = chunkDocument(doc)

    for (const chunk of chunks) {
      const slice = doc.slice(chunk.charStart, chunk.charEnd)
      expect(slice).toBe(chunk.content)
    }
  })

  test('多个片段各自定位准确', () => {
    const doc = `## 甲\n\nAAAA\n\n## 乙\n\nBBBB\n\n## 丙\n\nCCCC\n`
    const chunks = chunkDocument(doc)

    expect(chunks.every((c) => doc.slice(c.charStart, c.charEnd) === c.content)).toBe(true)
    expect(new Set(chunks.map((c) => c.charStart)).size).toBe(chunks.length)
  })

  test('同一文本重复出现时定位不串位', () => {
    const doc = `## 一\n\n重复段落\n\n## 二\n\n重复段落\n`
    const chunks = chunkDocument(doc)
    const duplicates = chunks.filter((c) => c.content === '重复段落')

    expect(duplicates).toHaveLength(2)
    expect(duplicates[0]!.charStart).not.toBe(duplicates[1]!.charStart)
  })
})

describe('超长内容切分', () => {
  test('超过上限的段落被切成多块', () => {
    const long = '这是一句话。'.repeat(600) // 约 3600 字符
    const chunks = chunkDocument(long)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.content.length <= MAX_CHUNK_CHARS + 50)).toBe(true)
  })

  test('切分后仍满足字符区间一致性', () => {
    const long = '第一句。第二句！第三句？'.repeat(200)
    const chunks = chunkDocument(long)

    expect(chunks.every((c) => long.slice(c.charStart, c.charEnd) === c.content)).toBe(true)
  })

  test('无标点的长文本也能切分', () => {
    const noPunctuation = 'a'.repeat(MAX_CHUNK_CHARS * 3)
    const chunks = chunkDocument(noPunctuation)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.content.length <= MAX_CHUNK_CHARS)).toBe(true)
  })
})

describe('边界情况', () => {
  test('空文档返回空数组', () => {
    expect(chunkDocument('')).toEqual([])
    expect(chunkDocument('   \n\n  ')).toEqual([])
  })

  test('只有标题时不丢内容', () => {
    const chunks = chunkDocument('# 只有一个标题\n')
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.content).toBe('只有一个标题')
  })

  test('无标题的纯文本被当作单个片段', () => {
    const chunks = chunkDocument('就是一段普通文本，没有标题。')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).toBe('就是一段普通文本，没有标题。')
    expect(chunks[0]!.heading).toBeUndefined()
  })

  test('不产生空内容的片段', () => {
    const doc = `# A\n\n\n\n# B\n\n实际内容\n`
    const chunks = chunkDocument(doc)
    expect(chunks.every((c) => c.content.trim() !== '')).toBe(true)
  })

  test('CRLF 换行不影响定位', () => {
    const doc = '# 标题\r\n\r\n正文内容\r\n'
    const chunks = chunkDocument(doc)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.some((c) => c.content.includes('正文内容'))).toBe(true)
  })
})
