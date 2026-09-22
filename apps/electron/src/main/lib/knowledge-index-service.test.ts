import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 知识索引服务测试（K1-03 剩余）。
 *
 * 覆盖：
 * 1. Vault 目录 → 文档 → 分块 → 落库的主链路。
 * 2. 增量更新：内容未变不重索引，变了才换版本。
 * 3. 失败隔离：单文件解析失败不影响其他文件，状态真实（不冒充完整）。
 * 4. 来源删除后索引内容不再可检索。
 *
 * 全部在临时目录进行，索引文件也放在临时配置根内。
 */

let tempDir: string
let vaultDir: string
const originalEnv = { ...process.env }

async function loadCatalog() {
  return import(`./knowledge-catalog-service?t=${Math.random()}`)
}

async function loadIndex() {
  return import(`./knowledge-index-service?t=${Math.random()}`)
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-index-svc-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
  vaultDir = join(tempDir, 'vault')
  mkdirSync(vaultDir, { recursive: true })
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

/** 注册一个包含 vault 来源的知识库并返回其 id */
async function setupKnowledgeBase() {
  const catalog = await loadCatalog()
  const source = catalog.createSource({ type: 'vault', name: '测试库来源', locator: vaultDir })
  const kb = catalog.createKnowledgeBase({ name: '测试库', sourceIds: [source.id] })
  return { catalog, sourceId: source.id, knowledgeBaseId: kb.id }
}

describe('Vault 索引主链路', () => {
  test('目录文件被索引进库并可检索', async () => {
    writeFileSync(join(vaultDir, '架构.md'), '# 架构\n\n本地优先的存储设计。\n', 'utf-8')
    const { knowledgeBaseId } = await setupKnowledgeBase()
    const index = await loadIndex()

    const result = await index.indexSource({ sourceType: 'vault', sourceId: 'nonexistent' })
    // 未注册的来源直接失败，不产生半套索引
    expect(result.ok).toBe(false)

    const catalog = await loadCatalog()
    const sources = catalog.listSources()
    const run = await index.indexSource({ sourceType: 'vault', sourceId: sources[0]!.id })
    expect(run.ok).toBe(true)
    if (!run.ok) return
    expect(run.indexed).toBe(1)
    expect(run.failed).toBe(0)

    // 经仓储可检索
    const store = await index.openKnowledgeIndexStore()
    const hits = store.knowledge.search('本地优先', { allowedKnowledgeBaseIds: [knowledgeBaseId] })
    expect(hits.hits.length).toBeGreaterThan(0)
    expect(hits.hits[0]!.relativePath).toBe('架构.md')
    store.close()
  })

  test('子目录文件被递归索引且相对路径正确', async () => {
    mkdirSync(join(vaultDir, 'projects'), { recursive: true })
    writeFileSync(join(vaultDir, 'projects', 'alpha.md'), '# Alpha\n\n项目内容。\n', 'utf-8')
    await setupKnowledgeBase()
    const index = await loadIndex()

    const run = await index.indexAllEnabledSources()
    expect(run.ok).toBe(true)
    if (!run.ok) return
    expect(run.indexed).toBe(1)

    const store = await index.openKnowledgeIndexStore()
    expect(store.knowledge.listDocuments(['*'] as unknown as string[]).length).toBe(0)
    const catalog = await loadCatalog()
    const kb = catalog.listKnowledgeBases()[0]!
    const hits = store.knowledge.search('项目内容', { allowedKnowledgeBaseIds: [kb.id] })
    expect(hits.hits[0]!.relativePath).toBe('projects/alpha.md')
    store.close()
  })

  test('非 Markdown 文件与隐藏目录被跳过', async () => {
    writeFileSync(join(vaultDir, 'note.md'), '# 笔记\n\n内容。\n', 'utf-8')
    writeFileSync(join(vaultDir, 'image.png'), 'binary', 'utf-8')
    mkdirSync(join(vaultDir, '.obsidian'), { recursive: true })
    writeFileSync(join(vaultDir, '.obsidian', 'config.md'), '# 不应被索引\n', 'utf-8')
    await setupKnowledgeBase()
    const index = await loadIndex()

    const run = await index.indexAllEnabledSources()
    expect(run.ok).toBe(true)
    if (!run.ok) return
    expect(run.indexed).toBe(1)
  })
})

describe('增量更新', () => {
  test('内容未变时重跑索引不重复处理', async () => {
    writeFileSync(join(vaultDir, 'a.md'), '# A\n\n第一版内容。\n', 'utf-8')
    await setupKnowledgeBase()
    const index = await loadIndex()

    const first = await index.indexAllEnabledSources()
    expect(first.ok && first.indexed).toBe(1)

    const second = await index.indexAllEnabledSources()
    expect(second.ok && second.indexed).toBe(0)
    expect(second.ok && second.unchanged).toBe(1)
  })

  test('内容变化后重新索引出新高版本', async () => {
    writeFileSync(join(vaultDir, 'a.md'), '# A\n\n第一版。\n', 'utf-8')
    await setupKnowledgeBase()
    const index = await loadIndex()
    await index.indexAllEnabledSources()

    writeFileSync(join(vaultDir, 'a.md'), '# A\n\n第二版全新的内容。\n', 'utf-8')
    const rerun = await index.indexAllEnabledSources()
    expect(rerun.ok && rerun.indexed).toBe(1)

    const catalog = await loadCatalog()
    const kb = catalog.listKnowledgeBases()[0]!
    const store = await index.openKnowledgeIndexStore()
    expect(store.knowledge.search('第一版', { allowedKnowledgeBaseIds: [kb.id] }).hits).toHaveLength(0)
    expect(store.knowledge.search('第二版全新', { allowedKnowledgeBaseIds: [kb.id] }).hits.length).toBeGreaterThan(0)
    store.close()
  })

  test('文件删除后索引内容不再可检索', async () => {
    writeFileSync(join(vaultDir, 'gone.md'), '# 会消失\n\n临时内容。\n', 'utf-8')
    await setupKnowledgeBase()
    const index = await loadIndex()
    await index.indexAllEnabledSources()

    const { rmSync: rm } = await import('node:fs')
    rm(join(vaultDir, 'gone.md'))
    await index.indexAllEnabledSources()

    const catalog = await loadCatalog()
    const kb = catalog.listKnowledgeBases()[0]!
    const store = await index.openKnowledgeIndexStore()
    expect(store.knowledge.search('临时内容', { allowedKnowledgeBaseIds: [kb.id] }).hits).toHaveLength(0)
    store.close()
  })
})

describe('失败隔离与状态真实', () => {
  test('单文件读取失败不影响其他文件，结果标记 failed', async () => {
    writeFileSync(join(vaultDir, 'good.md'), '# 正常\n\n正常内容。\n', 'utf-8')
    // 无读权限的文件：扫描可见但读取抛 EACCES（以非 root 运行时成立）
    const badPath = join(vaultDir, 'bad.md')
    writeFileSync(badPath, '秘密', 'utf-8')
    const { chmodSync } = await import('node:fs')
    chmodSync(badPath, 0o000)

    await setupKnowledgeBase()
    const index = await loadIndex()

    const run = await index.indexAllEnabledSources()
    if (!run.ok) throw new Error('索引运行不应整体失败')
    expect(run.indexed).toBe(1)
    expect(run.failed).toBe(1)
    expect(run.errors.length).toBe(1)
    expect(run.errors[0]).toContain('bad.md')
  })

  test('来源路径不存在时返回失败且不崩溃', async () => {
    const catalog = await loadCatalog()
    const source = catalog.createSource({ type: 'vault', name: '幽灵', locator: join(tempDir, '不存在') })
    catalog.createKnowledgeBase({ name: '库', sourceIds: [source.id] })
    const index = await loadIndex()

    const run = await index.indexSource({ sourceType: 'vault', sourceId: source.id })
    expect(run.ok).toBe(false)
  })

  test('索引状态查询反映真实计数', async () => {
    writeFileSync(join(vaultDir, 'x.md'), '# X\n\n内容。\n', 'utf-8')
    await setupKnowledgeBase()
    const index = await loadIndex()
    await index.indexAllEnabledSources()

    const catalog = await loadCatalog()
    const kb = catalog.listKnowledgeBases()[0]!
    const status = index.getKnowledgeIndexStatus([kb.id])
    expect(status.documentCount).toBe(1)
    expect(status.lastIndexedAt).toBeGreaterThan(0)
  })
})

describe('来源撤销', () => {
  test('删除来源会清理其索引文档', async () => {
    writeFileSync(join(vaultDir, 'a.md'), '# A\n\n内容。\n', 'utf-8')
    const { catalog, sourceId, knowledgeBaseId } = await setupKnowledgeBase()
    const index = await loadIndex()
    await index.indexAllEnabledSources()

    catalog.deleteSource(sourceId)
    const removed = index.removeSourceFromIndex(sourceId)

    expect(removed).toBe(1)
    const store = await index.openKnowledgeIndexStore()
    expect(store.knowledge.search('内容', { allowedKnowledgeBaseIds: [knowledgeBaseId] }).hits).toHaveLength(0)
    store.close()
  })
})

describe('HTML 文件索引', () => {
  test('Given vault 含 .html 文件 When 索引 Then 按纯文本分块、标题取 <title>、可检索', async () => {
    writeFileSync(
      join(vaultDir, 'report.html'),
      '<!DOCTYPE html><html><head><title>季度报告</title><style>body{color:red}</style></head>' +
        '<body><h1>季度报告</h1><p>北极星指标环比增长。</p><script>alert(1)</script></body></html>',
      'utf-8',
    )
    const { knowledgeBaseId } = await setupKnowledgeBase()
    const index = await loadIndex()
    const catalog = await loadCatalog()
    const run = await index.indexSource({ sourceType: 'vault', sourceId: catalog.listSources()[0]!.id })

    expect(run.ok).toBe(true)
    if (!run.ok) return
    expect(run.indexed).toBe(1)

    const store = await index.openKnowledgeIndexStore()
    const hits = store.knowledge.search('北极星指标', { allowedKnowledgeBaseIds: [knowledgeBaseId] })
    expect(hits.hits.length).toBeGreaterThan(0)
    expect(hits.hits[0]!.relativePath).toBe('report.html')
    expect(hits.hits[0]!.title).toBe('季度报告')
    // 分块内容应是纯文本：脚本与标签噪音不进入索引
    const doc = store.knowledge.listDocumentsBySource(catalog.listSources()[0]!.id)
    const chunks = store.knowledge.listChunks(doc[0]!.id)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((c: { content: string }) => !c.content.includes('<script') && !c.content.includes('color:red'))).toBe(true)
    store.close()
  })
})
