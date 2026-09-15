import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 知识范围解析测试（K1-02）。
 *
 * 这是权限边界的核心：Agent 只能看到会话范围内、且当前 Project 仍然允许的
 * 资料。测试重点是负例 —— 越权、伪造 ID、撤权后仍返回旧内容都必须失败。
 *
 * 全部在临时配置目录内进行。
 */

let tempDir: string
let vaultA: string
let vaultB: string
const originalEnv = { ...process.env }

async function loadCatalog() {
  return import(`./knowledge-catalog-service?t=${Math.random()}`)
}

async function loadScope() {
  return import(`./knowledge-scope-service?t=${Math.random()}`)
}

/** 建立一个包含单个不可检索来源的知识库 */
async function makeKnowledgeBase(name: string, locator: string, enabled = true) {
  const catalog = await loadCatalog()
  const source = catalog.createSource({ type: 'vault', name: `${name}-source`, locator })
  return catalog.createKnowledgeBase({ name, sourceIds: [source.id], enabled })
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-scope-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
  vaultA = join(tempDir, 'vault-a')
  vaultB = join(tempDir, 'vault-b')
  mkdirSync(vaultA, { recursive: true })
  mkdirSync(vaultB, { recursive: true })
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

describe('会话知识范围解析', () => {
  test('未配置知识范围的会话解析为空范围', async () => {
    const scope = await loadScope()
    const resolved = scope.resolveKnowledgeScope({ sessionId: 's1', sessionMeta: {} })
    expect(resolved.mode).toBe('none')
    expect(resolved.knowledgeBaseIds).toEqual([])
  })

  test('旧会话没有知识字段时不会退回全库搜索', async () => {
    await makeKnowledgeBase('库A', vaultA)
    const scope = await loadScope()

    // 旧会话 meta 完全没有 knowledgeScopeMode
    const resolved = scope.resolveKnowledgeScope({ sessionId: 's1', sessionMeta: { title: '老会话' } })
    expect(resolved.mode).toBe('none')
    expect(resolved.knowledgeBaseIds).toEqual([])
  })

  test('explicit 模式只返回显式选定的知识库', async () => {
    const kbA = await makeKnowledgeBase('库A', vaultA)
    await makeKnowledgeBase('库B', vaultB)
    const scope = await loadScope()

    const resolved = scope.resolveKnowledgeScope({
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'explicit', explicitKnowledgeBaseIds: [kbA.id] },
    })
    expect(resolved.mode).toBe('explicit')
    expect(resolved.knowledgeBaseIds).toEqual([kbA.id])
  })

  test('explicit 模式引用不存在的知识库时被过滤掉', async () => {
    const kbA = await makeKnowledgeBase('库A', vaultA)
    const scope = await loadScope()

    const resolved = scope.resolveKnowledgeScope({
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'explicit', explicitKnowledgeBaseIds: [kbA.id, '伪造-ID'] },
    })
    expect(resolved.knowledgeBaseIds).toEqual([kbA.id])
  })

  test('project 模式取当前 Project 关联的知识库', async () => {
    const catalog = await loadCatalog()
    const kbA = await makeKnowledgeBase('库A', vaultA)
    const kbB = await makeKnowledgeBase('库B', vaultB)
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kbA.id })
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kbB.id })

    const scope = await loadScope()
    const resolved = scope.resolveKnowledgeScope({
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'project', projectId: 'p1' },
    })
    expect(resolved.mode).toBe('project')
    expect(resolved.knowledgeBaseIds.sort()).toEqual([kbA.id, kbB.id].sort())
  })

  test('project 模式不能看到未关联到该 Project 的知识库', async () => {
    const catalog = await loadCatalog()
    const kbA = await makeKnowledgeBase('库A', vaultA)
    const kbB = await makeKnowledgeBase('库B', vaultB)
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kbA.id })
    catalog.bindProject({ projectId: 'p2', knowledgeBaseId: kbB.id })

    const scope = await loadScope()
    const resolved = scope.resolveKnowledgeScope({
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'project', projectId: 'p1' },
    })
    expect(resolved.knowledgeBaseIds).toEqual([kbA.id])
    expect(resolved.knowledgeBaseIds).not.toContain(kbB.id)
  })

  test('project 模式缺少 projectId 时返回空范围', async () => {
    await makeKnowledgeBase('库A', vaultA)
    const scope = await loadScope()

    const resolved = scope.resolveKnowledgeScope({
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'project' },
    })
    expect(resolved.knowledgeBaseIds).toEqual([])
  })

  test('停用的知识库被排除在范围外', async () => {
    const kb = await makeKnowledgeBase('停用库', vaultA, false)
    const scope = await loadScope()

    const resolved = scope.resolveKnowledgeScope({
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'explicit', explicitKnowledgeBaseIds: [kb.id] },
    })
    expect(resolved.knowledgeBaseIds).toEqual([])
  })
})

describe('检索范围（含来源级校验）', () => {
  test('解析出可检索来源及其 locator', async () => {
    const kb = await makeKnowledgeBase('库A', vaultA)
    const scope = await loadScope()

    const result = scope.resolveRetrievableScope({
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'explicit', explicitKnowledgeBaseIds: [kb.id] },
    })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]!.locator).toBe(vaultA)
  })

  test('来源被停用后不再出现在可检索范围', async () => {
    const catalog = await loadCatalog()
    const source = catalog.createSource({ type: 'vault', name: '来源', locator: vaultA })
    const kb = catalog.createKnowledgeBase({ name: '库', sourceIds: [source.id] })

    const scope = await loadScope()
    const request = {
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'explicit' as const, explicitKnowledgeBaseIds: [kb.id] },
    }
    expect(scope.resolveRetrievableScope(request).sources).toHaveLength(1)

    catalog.updateSource(source.id, { enabled: false })
    expect(scope.resolveRetrievableScope(request).sources).toHaveLength(0)
  })

  test('解除 Project 关联后立刻失去资料访问', async () => {
    const catalog = await loadCatalog()
    const kb = await makeKnowledgeBase('库', vaultA)
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kb.id })

    const scope = await loadScope()
    const request = {
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'project' as const, projectId: 'p1' },
    }
    expect(scope.resolveRetrievableScope(request).sources).toHaveLength(1)

    catalog.unbindProject({ projectId: 'p1', knowledgeBaseId: kb.id })
    expect(scope.resolveRetrievableScope(request).sources).toHaveLength(0)
  })
})

describe('范围修订号用于缓存失效', () => {
  test('目录变更会改变范围修订号', async () => {
    const kb = await makeKnowledgeBase('库', vaultA)
    const scope = await loadScope()
    const request = {
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'explicit' as const, explicitKnowledgeBaseIds: [kb.id] },
    }

    const before = scope.resolveKnowledgeScope(request).scopeRevision
    const catalog = await loadCatalog()
    catalog.updateKnowledgeBase(kb.id, { name: '改名后的库' })
    const after = scope.resolveKnowledgeScope(request).scopeRevision

    expect(after).not.toBe(before)
  })

  test('范围缩小时修订号变化，缓存键不再命中', async () => {
    const catalog = await loadCatalog()
    const kb = await makeKnowledgeBase('库', vaultA)
    catalog.bindProject({ projectId: 'p1', knowledgeBaseId: kb.id })

    const scope = await loadScope()
    const request = {
      sessionId: 's1',
      sessionMeta: { knowledgeScopeMode: 'project' as const, projectId: 'p1' },
    }
    const before = scope.resolveKnowledgeScope(request).scopeRevision
    catalog.unbindProject({ projectId: 'p1', knowledgeBaseId: kb.id })
    const after = scope.resolveKnowledgeScope(request).scopeRevision

    expect(after).not.toBe(before)
  })
})

describe('子 Agent 范围不扩大', () => {
  test('子会话继承父会话范围', async () => {
    const kb = await makeKnowledgeBase('库', vaultA)
    const scope = await loadScope()

    const parent = scope.resolveKnowledgeScope({
      sessionId: 'parent',
      sessionMeta: { knowledgeScopeMode: 'explicit', explicitKnowledgeBaseIds: [kb.id] },
    })
    const child = scope.resolveKnowledgeScope({
      sessionId: 'child',
      sessionMeta: {
        knowledgeScopeMode: 'explicit',
        explicitKnowledgeBaseIds: [kb.id],
        parentSessionId: 'parent',
      },
    })
    expect(child.knowledgeBaseIds).toEqual(parent.knowledgeBaseIds)
  })

  test('子会话请求超出父范围的知识库时被拒绝', async () => {
    const kbA = await makeKnowledgeBase('库A', vaultA)
    const kbB = await makeKnowledgeBase('库B', vaultB)
    const scope = await loadScope()

    const result = scope.assertScopeNotExpanded({
      parentKnowledgeBaseIds: [kbA.id],
      requestedKnowledgeBaseIds: [kbA.id, kbB.id],
    })
    expect(result).toBe(false)
  })
})
