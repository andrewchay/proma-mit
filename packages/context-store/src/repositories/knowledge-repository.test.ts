import { describe, expect, test } from 'bun:test'
import { openContextStore } from '../store.ts'
import type { KnowledgeChunkInput } from './knowledge-repository.ts'

/**
 * 知识索引仓储测试（K1-03）。
 *
 * 最重要的一条：**范围过滤必须在 SQL 层完成**。先全库检索再在应用层过滤，
 * 会让越权内容参与排序与 limit 截断 —— 既污染召回，又容易在后续改动中泄漏。
 */

function chunk(index: number, content: string): KnowledgeChunkInput {
  return {
    id: `c${index}`,
    chunkIndex: index,
    content,
    charStart: 0,
    charEnd: content.length,
  }
}

async function makeStore() {
  return openContextStore({ path: undefined })
}

function insertDoc(
  store: Awaited<ReturnType<typeof makeStore>>,
  input: {
    id: string
    knowledgeBaseId: string
    sourceId?: string
    relativePath: string
    title: string
    chunks: KnowledgeChunkInput[]
    contentHash?: string
    modifiedAt?: number
  },
) {
  const now = input.modifiedAt ?? Date.now()
  store.knowledge.upsertDocument({
    document: {
      id: input.id,
      knowledgeBaseId: input.knowledgeBaseId,
      sourceId: input.sourceId ?? 'source-1',
      relativePath: input.relativePath,
      title: input.title,
      contentHash: input.contentHash ?? `hash-${input.id}`,
      byteSize: 100,
      modifiedAt: now,
      indexedAt: now,
      updatedAt: now,
    },
    chunks: input.chunks,
  })
}

describe('知识索引范围过滤', () => {
  test('只返回允许知识库内的命中', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-a', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: '产品方案', chunks: [chunk(0, '这是产品方案的内容')] })
    insertDoc(store, { id: 'd-b', knowledgeBaseId: 'kb-b', relativePath: 'b.md', title: '产品方案', chunks: [chunk(0, '这是产品方案的内容')] })

    const result = store.knowledge.search('产品', { allowedKnowledgeBaseIds: ['kb-a'] })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.knowledgeBaseId).toBe('kb-a')
  })

  test('空范围直接返回空结果，不退化为全库搜索', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-a', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: '内容', chunks: [chunk(0, '关键词内容')] })

    const result = store.knowledge.search('关键词', { allowedKnowledgeBaseIds: [] })
    expect(result.hits).toEqual([])
  })

  test('范围外的高分内容不会被 limit 截断后漏掉范围内内容', async () => {
    const store = await makeStore()
    // 范围外 5 篇同关键词文档
    for (let i = 0; i < 5; i += 1) {
      insertDoc(store, { id: `out-${i}`, knowledgeBaseId: 'kb-out', relativePath: `o${i}.md`, title: '关键词', chunks: [chunk(0, '关键词 关键词 关键词')] })
    }
    // 范围内 1 篇
    insertDoc(store, { id: 'in-1', knowledgeBaseId: 'kb-in', relativePath: 'i.md', title: '关键词', chunks: [chunk(0, '关键词 只出现一次')] })

    const result = store.knowledge.search('关键词', { allowedKnowledgeBaseIds: ['kb-in'], limit: 1 })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.documentId).toBe('in-1')
  })

  test('可按来源进一步收窄', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', sourceId: 's1', relativePath: 'a.md', title: '甲', chunks: [chunk(0, '共同关键词')] })
    insertDoc(store, { id: 'd-2', knowledgeBaseId: 'kb-a', sourceId: 's2', relativePath: 'b.md', title: '乙', chunks: [chunk(0, '共同关键词')] })

    const result = store.knowledge.search('关键词', { allowedKnowledgeBaseIds: ['kb-a'], sourceIds: ['s2'] })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.sourceId).toBe('s2')
  })

  test('countDocuments 同样遵守范围', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-a', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: 'A', chunks: [chunk(0, 'x')] })
    insertDoc(store, { id: 'd-b', knowledgeBaseId: 'kb-b', relativePath: 'b.md', title: 'B', chunks: [chunk(0, 'x')] })

    expect(store.knowledge.countDocuments(['kb-a'])).toBe(1)
    expect(store.knowledge.countDocuments([])).toBe(0)
    expect(store.knowledge.countDocuments(['kb-a', 'kb-b'])).toBe(2)
  })
})

describe('文档版本切换', () => {
  test('重新索引同一文档时旧分块整体消失', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: '标题', chunks: [chunk(0, '旧版本特有的词 甲')] })

    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: '标题', contentHash: 'hash-new', chunks: [chunk(0, '新版本特有的词 乙')] })

    expect(store.knowledge.search('甲', { allowedKnowledgeBaseIds: ['kb-a'] }).hits).toHaveLength(0)
    expect(store.knowledge.search('乙', { allowedKnowledgeBaseIds: ['kb-a'] }).hits).toHaveLength(1)
    expect(store.knowledge.listChunks('d-1')).toHaveLength(1)
  })

  test('删除文档会连带删除分块', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: '标题', chunks: [chunk(0, '词'), chunk(1, '词二')] })
    expect(store.knowledge.listChunks('d-1')).toHaveLength(2)

    store.knowledge.deleteDocument('d-1')
    expect(store.knowledge.listChunks('d-1')).toHaveLength(0)
    expect(store.knowledge.search('词', { allowedKnowledgeBaseIds: ['kb-a'] }).hits).toHaveLength(0)
  })

  test('按来源删除会清理该来源的全部文档', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', sourceId: 's1', relativePath: 'a.md', title: 'A', chunks: [chunk(0, '甲')] })
    insertDoc(store, { id: 'd-2', knowledgeBaseId: 'kb-a', sourceId: 's1', relativePath: 'b.md', title: 'B', chunks: [chunk(0, '乙')] })
    insertDoc(store, { id: 'd-3', knowledgeBaseId: 'kb-a', sourceId: 's2', relativePath: 'c.md', title: 'C', chunks: [chunk(0, '丙')] })

    expect(store.knowledge.deleteBySource('s1')).toBe(2)
    expect(store.knowledge.listDocuments(['kb-a'])).toHaveLength(1)
  })
})

describe('检索降级与中文分词', () => {
  test('中文短语可被检索', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: '架构', chunks: [chunk(0, 'Gravitas 采用本地优先的存储设计')] })

    const hits = store.knowledge.search('本地优先', { allowedKnowledgeBaseIds: ['kb-a'] }).hits
    expect(hits.length).toBeGreaterThan(0)
  })

  test('长查询无严格命中时降级到单字档并标记 relaxed', async () => {
    const store = await makeStore()
    // 文本含查询的全部单字，但两两不相邻，因此所有 bigram 都不命中：
    // 严格档失败，单字档命中 —— 这正是 relaxed 档存在的意义。
    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: '笔记', chunks: [chunk(0, '知，识，库')] })

    const result = store.knowledge.search('知识库', { allowedKnowledgeBaseIds: ['kb-a'] })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.relaxed).toBe(true)
  })

  test('严格档命中时不标记 relaxed', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: '笔记', chunks: [chunk(0, '知识库范围解析')] })

    // 全部 bigram 都命中，严格档直接返回
    const result = store.knowledge.search('范围解析', { allowedKnowledgeBaseIds: ['kb-a'] })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.relaxed).toBe(false)
  })

  test('严格档命中时不标记 relaxed', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: '笔记', chunks: [chunk(0, '知识库范围解析')] })

    // 全部 bigram 都命中，严格档直接返回
    const result = store.knowledge.search('范围解析', { allowedKnowledgeBaseIds: ['kb-a'] })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.relaxed).toBe(false)
  })

  test('空查询返回空结果', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: 'A', chunks: [chunk(0, '内容')] })
    expect(store.knowledge.search('   ', { allowedKnowledgeBaseIds: ['kb-a'] }).hits).toEqual([])
  })

  test('命中带可定位的字符区间与来源信息', async () => {
    const store = await makeStore()
    insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', sourceId: 's1', relativePath: 'docs/架构.md', title: '架构说明', chunks: [{ id: 'c0', chunkIndex: 0, heading: '概览', content: '范围解析是权限边界', charStart: 10, charEnd: 30 }] })

    const hit = store.knowledge.search('权限边界', { allowedKnowledgeBaseIds: ['kb-a'] }).hits[0]!
    expect(hit.relativePath).toBe('docs/架构.md')
    expect(hit.heading).toBe('概览')
    expect(hit.charStart).toBe(10)
    expect(hit.charEnd).toBe(30)
    expect(hit.contentHash).toBe('hash-d-1')
  })
})

describe('持久化', () => {
  test('索引内容在重开后仍可读', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-index-'))
    const path = join(dir, 'index.db')

    try {
      const store = await openContextStore({ path })
      insertDoc(store, { id: 'd-1', knowledgeBaseId: 'kb-a', relativePath: 'a.md', title: '标题', chunks: [chunk(0, '持久化内容')] })
      store.close()

      const reopened = await openContextStore({ path })
      expect(reopened.knowledge.search('持久化', { allowedKnowledgeBaseIds: ['kb-a'] }).hits).toHaveLength(1)
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
