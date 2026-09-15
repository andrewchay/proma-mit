import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 知识目录服务测试（K1-01）。
 *
 * 重点验证三件事：
 * 1. 旧 Vault 幂等迁移 —— 重复启动不重复建库，中断重跑不丢数据。
 * 2. 修订号乐观并发 —— 并发元数据写入不能静默丢失。
 * 3. 未知 schema 版本失败关闭 —— 不能拿旧代码读新数据。
 *
 * 全部在临时配置目录内进行，不触碰真实 ~/.gravitas。
 */

let tempDir: string
let vaultDir: string
const originalEnv = { ...process.env }

/** 写入一份旧版 vaults.json，模拟迁移前状态 */
function writeLegacyVaults(vaults: Array<{ id: string; name: string; path: string; type: string; enabled: boolean }>): void {
  const dir = join(tempDir, 'knowledge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'vaults.json'),
    JSON.stringify(vaults.map((v) => ({ ...v, createdAt: new Date().toISOString() })), null, 2),
  )
}

async function loadCatalog() {
  return import(`./knowledge-catalog-service?t=${Math.random()}`)
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-catalog-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
  vaultDir = join(tempDir, 'vault')
  mkdirSync(vaultDir, { recursive: true })
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

describe('旧 Vault 幂等迁移', () => {
  test('每个旧 Vault 迁移为一个 Source 和一个默认知识库', async () => {
    writeLegacyVaults([{ id: 'v1', name: '笔记库', path: vaultDir, type: 'obsidian', enabled: true }])
    const catalog = await loadCatalog()

    const result = catalog.migrateLegacyVaults()
    expect(result.migrated).toBe(1)

    const snapshot = catalog.readCatalog()
    expect(snapshot.sources).toHaveLength(1)
    expect(snapshot.knowledgeBases).toHaveLength(1)
    expect(snapshot.sources[0]!.legacyVaultId).toBe('v1')
    expect(snapshot.sources[0]!.locator).toBe(vaultDir)
    expect(snapshot.knowledgeBases[0]!.sourceIds).toEqual([snapshot.sources[0]!.id])
    expect(snapshot.knowledgeBases[0]!.name).toBe('笔记库')
  })

  test('重复执行迁移不重复建库（幂等）', async () => {
    writeLegacyVaults([{ id: 'v1', name: '库', path: vaultDir, type: 'folder', enabled: true }])
    const catalog = await loadCatalog()

    catalog.migrateLegacyVaults()
    const second = catalog.migrateLegacyVaults()
    expect(second.migrated).toBe(0)
    expect(second.skipped).toBe(1)

    const snapshot = catalog.readCatalog()
    expect(snapshot.sources).toHaveLength(1)
    expect(snapshot.knowledgeBases).toHaveLength(1)
  })

  test('迁移中断后重跑不产生重复条目', async () => {
    writeLegacyVaults([
      { id: 'v1', name: '甲', path: vaultDir, type: 'folder', enabled: true },
      { id: 'v2', name: '乙', path: join(tempDir, 'vault2'), type: 'folder', enabled: false },
    ])
    const catalog = await loadCatalog()

    catalog.migrateLegacyVaults()
    const snapshot = catalog.readCatalog()
    expect(snapshot.sources).toHaveLength(2)

    // 再次执行视为重跑（模拟上次写入成功但标记未落盘）
    catalog.migrateLegacyVaults()
    expect(catalog.readCatalog().sources).toHaveLength(2)
  })

  test('旧 vaults.json 保留不被删除', async () => {
    writeLegacyVaults([{ id: 'v1', name: '库', path: vaultDir, type: 'obsidian', enabled: true }])
    const catalog = await loadCatalog()
    catalog.migrateLegacyVaults()

    const legacyPath = join(tempDir, 'knowledge', 'vaults.json')
    expect(existsSync(legacyPath)).toBe(true)
    expect(JSON.parse(readFileSync(legacyPath, 'utf-8'))).toHaveLength(1)
  })

  test('没有旧数据时不创建迁移标记之外的内容', async () => {
    const catalog = await loadCatalog()
    const result = catalog.migrateLegacyVaults()
    expect(result.migrated).toBe(0)

    const snapshot = catalog.readCatalog()
    expect(snapshot.sources).toHaveLength(0)
    expect(snapshot.knowledgeBases).toHaveLength(0)
  })
})

describe('目录修订与并发', () => {
  test('变更会递增修订号', async () => {
    const catalog = await loadCatalog()
    const before = catalog.readCatalog().revision.revision

    catalog.createKnowledgeBase({ name: '新库' })
    const after = catalog.readCatalog().revision.revision
    expect(after).toBeGreaterThan(before)
  })

  test('携带过期修订号写入被拒绝', async () => {
    const catalog = await loadCatalog()
    const stale = catalog.readCatalog().revision.revision

    catalog.createKnowledgeBase({ name: '先写入的库' })

    expect(() =>
      catalog.createKnowledgeBase({ name: '并发库' }, { expectedRevision: stale }),
    ).toThrow('已被其他操作修改')
  })

  test('携带当前修订号写入成功', async () => {
    const catalog = await loadCatalog()
    const current = catalog.readCatalog().revision.revision

    expect(() =>
      catalog.createKnowledgeBase({ name: '顺序库' }, { expectedRevision: current }),
    ).not.toThrow()
  })

  test('同一路径注册第二个来源时给出提示而非自动合并', async () => {
    const catalog = await loadCatalog()
    catalog.createSource({ type: 'vault', name: '第一个', locator: vaultDir })

    expect(() =>
      catalog.createSource({ type: 'vault', name: '第二个', locator: vaultDir }),
    ).toThrow('已注册')
  })
})

describe('schema 版本与失败关闭', () => {
  test('未知 schema 版本时读取失败关闭', async () => {
    const catalog = await loadCatalog()
    // 先创建，再手工把版本改成未来版本
    catalog.createKnowledgeBase({ name: '库' })
    const path = join(tempDir, 'knowledge', 'catalog.json')
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    raw.schemaVersion = 999
    writeFileSync(path, JSON.stringify(raw, null, 2))

    expect(() => catalog.readCatalog()).toThrow('不被当前版本支持')
  })

  test('目录文件损坏时报错而不是静默返回空目录', async () => {
    const catalog = await loadCatalog()
    catalog.createKnowledgeBase({ name: '库' })
    writeFileSync(join(tempDir, 'knowledge', 'catalog.json'), '{ 这不是 JSON')

    expect(() => catalog.readCatalog()).toThrow()
  })
})

describe('知识库与来源的成员关系', () => {
  test('一个知识库可包含多个来源', async () => {
    const catalog = await loadCatalog()
    const s1 = catalog.createSource({ type: 'vault', name: '库A', locator: vaultDir })
    const s2 = catalog.createSource({ type: 'vault', name: '库B', locator: join(tempDir, 'vault2') })

    const kb = catalog.createKnowledgeBase({ name: '合集', sourceIds: [s1.id, s2.id] })
    expect(kb.sourceIds).toEqual([s1.id, s2.id])
  })

  test('未启用的来源不会被当作可检索成员', async () => {
    const catalog = await loadCatalog()
    const s = catalog.createSource({ type: 'vault', name: '停用库', locator: vaultDir, enabled: false })
    const kb = catalog.createKnowledgeBase({ name: '库', sourceIds: [s.id] })

    const members = catalog.listRetrievableSources(kb.id)
    expect(members).toHaveLength(0)
  })

  test('停用知识库后其来源不再可检索', async () => {
    const catalog = await loadCatalog()
    const s = catalog.createSource({ type: 'vault', name: '库', locator: vaultDir })
    const kb = catalog.createKnowledgeBase({ name: '库', sourceIds: [s.id] })
    expect(catalog.listRetrievableSources(kb.id)).toHaveLength(1)

    catalog.updateKnowledgeBase(kb.id, { enabled: false })
    expect(catalog.listRetrievableSources(kb.id)).toHaveLength(0)
  })
})

describe('Project 关联', () => {
  test('解除关联只改绑定，不删除知识库', async () => {
    const catalog = await loadCatalog()
    const kb = catalog.createKnowledgeBase({ name: '库' })
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kb.id })

    catalog.unbindProject({ projectId: 'p1', knowledgeBaseId: kb.id })

    expect(catalog.listProjectBindings('p1')).toHaveLength(0)
    expect(catalog.readCatalog().knowledgeBases).toHaveLength(1)
  })

  test('同一知识库可关联多个 Project', async () => {
    const catalog = await loadCatalog()
    const kb = catalog.createKnowledgeBase({ name: '共享库' })
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kb.id })
    catalog.bindProject({ projectId: 'p2', knowledgeBaseId: kb.id })

    expect(catalog.listProjectBindings('p1')).toHaveLength(1)
    expect(catalog.listProjectBindings('p2')).toHaveLength(1)
  })

  test('重复关联同一 Project 与知识库是幂等的', async () => {
    const catalog = await loadCatalog()
    const kb = catalog.createKnowledgeBase({ name: '库' })
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kb.id })
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kb.id })

    expect(catalog.listProjectBindings('p1')).toHaveLength(1)
  })

  test('关联不存在的知识库被拒绝', async () => {
    const catalog = await loadCatalog()
    expect(() =>
      catalog.bindProject({ projectId: 'p1', knowledgeBaseId: '不存在' }),
    ).toThrow('知识库不存在')
  })

  test('删除知识库时清理其关联绑定', async () => {
    const catalog = await loadCatalog()
    const kb = catalog.createKnowledgeBase({ name: '库' })
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kb.id })

    catalog.deleteKnowledgeBase(kb.id, { force: true })
    expect(catalog.listProjectBindings('p1')).toHaveLength(0)
    expect(catalog.readCatalog().knowledgeBases).toHaveLength(0)
  })

  test('存在关联时删除知识库需要显式确认', async () => {
    const catalog = await loadCatalog()
    const kb = catalog.createKnowledgeBase({ name: '库' })
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kb.id })

    expect(() => catalog.deleteKnowledgeBase(kb.id)).toThrow('已被 Project 关联')
    expect(() => catalog.deleteKnowledgeBase(kb.id, { force: true })).not.toThrow()
  })
})
