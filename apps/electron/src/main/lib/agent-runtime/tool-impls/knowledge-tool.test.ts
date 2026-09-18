import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../types.ts'

/**
 * 知识工具测试（K1-04）。
 *
 * 覆盖权限边界的主要负例：
 * - 未配置范围时不检索、提示明确
 * - 范围外文档读取被拒
 * - 伪造 documentId / chunkIndex 被拒
 * - 检索结果携带可定位的引用信息
 *
 * 会话元数据通过 PROMA_TEST_CONFIG_DIR 内的临时 agent-sessions.json 隔离。
 */

let tempDir: string
let vaultDir: string
const originalEnv = { ...process.env }

async function loadSessionManager() {
  return import(`../../agent-session-manager?t=${Math.random()}`)
}

async function loadCatalog() {
  return import(`../../knowledge-catalog-service?t=${Math.random()}`)
}

async function loadIndex() {
  return import(`../../knowledge-index-service?t=${Math.random()}`)
}

async function loadTools() {
  return import(`./knowledge-tool?t=${Math.random()}`)
}

function makeCtx(sessionId: string): ToolContext {
  return { cwd: tempDir, sessionId }
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-tool-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
  vaultDir = join(tempDir, 'vault')
  mkdirSync(vaultDir, { recursive: true })
  writeFileSync(join(vaultDir, '产品.md'), '# 产品\n\n本地优先的存储设计。\n', 'utf-8')
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

/** 注册知识库并完成一次索引 */
async function setupIndexedKnowledgeBase() {
  const catalog = await loadCatalog()
  const source = catalog.createSource({ type: 'vault', name: '来源', locator: vaultDir })
  const kb = catalog.createKnowledgeBase({ name: '产品资料', sourceIds: [source.id] })
  const index = await loadIndex()
  await index.indexAllEnabledSources()
  return { catalog, kbId: kb.id as string, sourceId: source.id as string }
}

/** 建立一个显式指定知识库的会话 */
async function setupSession(kbIds: string[]) {
  const sessions = await loadSessionManager()
  const meta = sessions.createAgentSession('知识测试会话')
  sessions.updateAgentSessionMeta(meta.id, {
    knowledgeScopeMode: kbIds.length ? 'explicit' : 'none',
    explicitKnowledgeBaseIds: kbIds,
  })
  return meta.id as string
}

describe('SearchKnowledge 范围与提示', () => {
  test('未配置范围的会话返回未配置提示', async () => {
    await setupIndexedKnowledgeBase()
    const sessionId = await setupSession([])
    const tools = await loadTools()

    const result = await tools.executeSearchKnowledgeTool({ query: '存储' }, makeCtx(sessionId))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('未配置知识范围')
  })

  test('正常检索返回片段与引用信息', async () => {
    const { kbId } = await setupIndexedKnowledgeBase()
    const sessionId = await setupSession([kbId])
    const tools = await loadTools()

    const result = await tools.executeSearchKnowledgeTool({ query: '本地优先' }, makeCtx(sessionId))
    expect(result.isError ?? false).toBe(false)
    expect(result.content).toContain('documentId')
    expect(result.content).toContain('产品.md')
    expect(result.content).toContain('字符')
  })

  test('无索引内容时说明现状而不是伪称不存在', async () => {
    const { catalog } = await setupIndexedKnowledgeBase()
    // 新建一个从未索引过的空知识库，会话只允许它：countDocuments 为 0
    const emptySource = catalog.createSource({ type: 'vault', name: '空来源', locator: join(tempDir, 'empty-vault') })
    mkdirSync(join(tempDir, 'empty-vault'), { recursive: true })
    const emptyKb = catalog.createKnowledgeBase({ name: '空库', sourceIds: [emptySource.id] })

    const sessionId = await setupSession([emptyKb.id])
    const tools = await loadTools()
    const result = await tools.executeSearchKnowledgeTool({ query: '任何' }, makeCtx(sessionId))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('尚未建立索引')
  })

  test('来源已索引后被停用，旧索引立即不可检索', async () => {
    const { catalog, kbId, sourceId } = await setupIndexedKnowledgeBase()
    const sessionId = await setupSession([kbId])
    const tools = await loadTools()

    const before = await tools.executeSearchKnowledgeTool({ query: '本地优先' }, makeCtx(sessionId))
    expect(before.content).toContain('documentId')

    catalog.updateSource(sourceId, { enabled: false })
    const after = await tools.executeSearchKnowledgeTool({ query: '本地优先' }, makeCtx(sessionId))
    expect(after.isError).toBe(true)
    expect(after.content).not.toContain('documentId')
  })

  test('多来源知识库撤掉一个来源后只保留仍授权来源', async () => {
    const catalog = await loadCatalog()
    const activeVault = join(tempDir, 'active-vault')
    const revokedVault = join(tempDir, 'revoked-vault')
    mkdirSync(activeVault, { recursive: true })
    mkdirSync(revokedVault, { recursive: true })
    writeFileSync(join(activeVault, '公开.md'), '# 公开\n\n仍可访问的晨星资料。\n', 'utf-8')
    writeFileSync(join(revokedVault, '撤权.md'), '# 撤权\n\n已经撤权的夜莺机密。\n', 'utf-8')
    const activeSource = catalog.createSource({ type: 'vault', name: '公开来源', locator: activeVault })
    const revokedSource = catalog.createSource({ type: 'vault', name: '撤权来源', locator: revokedVault })
    const kb = catalog.createKnowledgeBase({
      name: '混合资料',
      sourceIds: [activeSource.id, revokedSource.id],
    })
    const index = await loadIndex()
    await index.indexAllEnabledSources()
    const sessionId = await setupSession([kb.id])
    const tools = await loadTools()

    catalog.updateSource(revokedSource.id, { enabled: false })

    const allowed = await tools.executeSearchKnowledgeTool({ query: '晨星资料' }, makeCtx(sessionId))
    expect(allowed.content).toContain('公开.md')
    const denied = await tools.executeSearchKnowledgeTool({ query: '夜莺机密' }, makeCtx(sessionId))
    expect(denied.content).toContain('没有找到')
    expect(denied.content).not.toContain('撤权.md')
  })

  test('空查询参数被拒绝', async () => {
    const { kbId } = await setupIndexedKnowledgeBase()
    const sessionId = await setupSession([kbId])
    const tools = await loadTools()

    const result = await tools.executeSearchKnowledgeTool({ query: '  ' }, makeCtx(sessionId))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('query')
  })
})

describe('ReadKnowledgeSource 范围校验', () => {
  test('读取范围内文档返回全文与版本信息', async () => {
    const { kbId } = await setupIndexedKnowledgeBase()
    const sessionId = await setupSession([kbId])
    const tools = await loadTools()

    const search = await tools.executeSearchKnowledgeTool({ query: '本地优先' }, makeCtx(sessionId))
    const documentId = /documentId: (\S+)/.exec(search.content)![1]!

    const result = await tools.executeReadKnowledgeSourceTool({ documentId }, makeCtx(sessionId))
    expect(result.isError ?? false).toBe(false)
    expect(result.content).toContain('# 产品')
    expect(result.content).toContain('本地优先的存储设计')
    expect(result.content).toContain('版本 ')
  })

  test('搜索后、读取前来源被撤权时拒绝旧 documentId', async () => {
    const { catalog, kbId, sourceId } = await setupIndexedKnowledgeBase()
    const sessionId = await setupSession([kbId])
    const tools = await loadTools()

    const search = await tools.executeSearchKnowledgeTool({ query: '本地优先' }, makeCtx(sessionId))
    const documentId = /documentId: (\S+)/.exec(search.content)![1]!
    catalog.updateSource(sourceId, { enabled: false })

    const result = await tools.executeReadKnowledgeSourceTool({ documentId }, makeCtx(sessionId))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不在当前会话的知识范围内')
    expect(result.content).not.toContain('本地优先的存储设计')
  })

  test('读取范围外文档被拒绝', async () => {
    const { catalog } = await setupIndexedKnowledgeBase()
    const otherVault = join(tempDir, 'other-vault')
    mkdirSync(otherVault, { recursive: true })
    writeFileSync(join(otherVault, 'secret.md'), '# 机密\n\n不应被读取的内容。\n', 'utf-8')
    const otherSource = catalog.createSource({ type: 'vault', name: '其他来源', locator: otherVault })
    const otherKb = catalog.createKnowledgeBase({ name: '机密库', sourceIds: [otherSource.id] })
    const index = await loadIndex()
    await index.indexAllEnabledSources()

    // 会话只允许第一个库
    const firstKb = (catalog.listKnowledgeBases() as Array<{ id: string }>).find((kb) => kb.id !== otherKb.id)!
    const sessionId = await setupSession([firstKb.id])
    const tools = await loadTools()

    // 从索引直接拿越权文档的 id（模拟模型拿到别处泄露的 ID）
    const store = await index.openKnowledgeIndexStore()
    const forbidden = store.knowledge.listDocuments([otherKb.id])[0]!

    const result = await tools.executeReadKnowledgeSourceTool({ documentId: forbidden.id }, makeCtx(sessionId))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不在当前会话的知识范围内')
    store.close()
  })

  test('伪造 documentId 被拒绝', async () => {
    const { kbId } = await setupIndexedKnowledgeBase()
    const sessionId = await setupSession([kbId])
    const tools = await loadTools()

    const result = await tools.executeReadKnowledgeSourceTool({ documentId: '伪造-ID' }, makeCtx(sessionId))
    expect(result.isError).toBe(true)
  })

  test('越界的 chunkIndex 被拒绝', async () => {
    const { kbId } = await setupIndexedKnowledgeBase()
    const sessionId = await setupSession([kbId])
    const tools = await loadTools()

    const search = await tools.executeSearchKnowledgeTool({ query: '本地优先' }, makeCtx(sessionId))
    const documentId = /documentId: (\S+)/.exec(search.content)![1]!

    const result = await tools.executeReadKnowledgeSourceTool({ documentId, chunkIndex: 99 }, makeCtx(sessionId))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('片段不存在')
  })
})
