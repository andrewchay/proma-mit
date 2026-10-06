import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Zotero 配置与只读导入测试（M2.6）：
 * - 配置校验与落盘（不含 apiKey）
 * - 未配置时导入报错
 * - 注入 fetch 的导入路径：条目落库、错误可见
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'zotero-config-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadAll() {
  return {
    config: await import(`./zotero-config?t=${Math.random()}`),
    svc: await import(`./source-service?t=${Math.random()}`),
    projectSvc: await import(`./research-service?t=${Math.random()}`),
  }
}

describe('Zotero 配置', () => {
  test('保存与读取（apiKey 不落盘）', async () => {
    const { config } = await loadAll()
    expect(config.readZoteroConfig()).toBeNull()

    const saved = config.saveZoteroConfig({ libraryId: '12345', libraryType: 'users' })
    expect(saved.baseUrl).toBe('http://localhost:23119/api')

    const read = config.readZoteroConfig()
    expect(read?.libraryId).toBe('12345')
    expect(read?.libraryType).toBe('users')
    expect(JSON.stringify(read)).not.toContain('apiKey')
  })

  test('空库 ID 拒绝；本地基址默认值正确', async () => {
    const { config } = await loadAll()
    expect(() => config.saveZoteroConfig({ libraryId: ' ' })).toThrow('库 ID')
    const web = config.saveZoteroConfig({ libraryId: '9', local: false })
    expect(web.baseUrl).toBe('https://api.zotero.org')
  })
})

describe('Zotero 只读导入', () => {
  test('未配置时拒绝导入', async () => {
    const { svc, projectSvc } = await loadAll()
    const project = await projectSvc.createResearchProject({
      title: 'Zotero 项目',
      domain: 'audiology',
      methodPath: 'quantitative',
    })
    expect(svc.importFromZotero(project.id)).rejects.toThrow('尚未配置 Zotero')
  })

  test('配置后导入条目并落库', async () => {
    const { config, svc, projectSvc } = await loadAll()
    const project = await projectSvc.createResearchProject({
      title: 'Zotero 导入项目',
      domain: 'audiology',
      methodPath: 'quantitative',
    })
    config.saveZoteroConfig({ libraryId: '12345' })

    const items = JSON.stringify([
      {
        key: 'K1',
        data: {
          key: 'K1',
          itemType: 'journalArticle',
          title: 'Imported From Zotero',
          creators: [{ creatorType: 'author', name: 'Author Z' }],
          date: '2020',
          DOI: '10.1/zot',
        },
      },
    ])
    const fetchFn = (async () => new Response(items, { status: 200 })) as unknown as typeof fetch

    const result = await svc.importFromZotero(project.id, { deps: { fetchFn } })
    expect(result.imported).toHaveLength(1)
    expect(result.errors).toEqual([])

    const sources = await svc.listSources(project.id)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.versions[0]!.title).toBe('Imported From Zotero')
    expect(sources[0]!.versions[0]!.externalIds).toContainEqual({ namespace: 'zotero', value: 'K1' })
  })

  test('HTTP 失败时错误可见且不落库', async () => {
    const { config, svc, projectSvc } = await loadAll()
    const project = await projectSvc.createResearchProject({
      title: 'Zotero 失败项目',
      domain: 'audiology',
      methodPath: 'quantitative',
    })
    config.saveZoteroConfig({ libraryId: '1' })

    const fetchFn = (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch
    const result = await svc.importFromZotero(project.id, { deps: { fetchFn } })
    expect(result.imported).toHaveLength(0)
    expect(result.errors[0]).toContain('403')
  })
})
