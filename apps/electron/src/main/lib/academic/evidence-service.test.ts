import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 证据服务集成测试：导入来源 → 抽取片段（校验定位器/归属）→ 列出。
 * 全部在 PROMA_TEST_CONFIG_DIR 隔离。
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'evidence-service-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function setup() {
  const projectSvc = await import(`./research-service?t=${Math.random()}`)
  const svc = await import(`./evidence-service?t=${Math.random()}`)
  const sourceSvc = await import(`./source-service?t=${Math.random()}`)
  const project = await projectSvc.createResearchProject({
    title: '证据测试项目',
    domain: 'audiology',
    methodPath: 'quantitative',
  })
  const [source] = await sourceSvc.importBibliography(
    project.id,
    'ris',
    'TY  - JOUR\nTI  - Evidence Source\nAB  - Background info.\nER  - \n',
  )
  return { svc, source: source! }
}

describe('evidence-service', () => {
  test('抽取证据并列出', async () => {
    const { svc, source } = await setup()
    const projectId = source.projectId

    const evidence = await svc.extractEvidence(projectId, {
      sourceId: source.id,
      sourceVersionId: source.versions[0]!.id,
      text: '降噪策略显著降低了聆听负荷（p < 0.01）。',
      locator: { kind: 'pdf-page', page: 8, anchor: '结果' },
      note: '主要结局数据',
    })

    expect(evidence.extractionMode).toBe('manual')
    const all = await svc.listEvidence(projectId)
    expect(all).toHaveLength(1)
    expect(all[0]!.text).toContain('聆听负荷')
  })

  test('无定位器/空片段/外部来源版本拒绝', async () => {
    const { svc, source } = await setup()
    const projectId = source.projectId
    const versionId = source.versions[0]!.id

    // 空片段
    expect(
      svc.extractEvidence(projectId, {
        sourceId: source.id,
        sourceVersionId: versionId,
        text: '   ',
        locator: { kind: 'page', page: 1 },
      }),
    ).rejects.toThrow('证据片段不能为空')

    // 非法页码
    expect(
      svc.extractEvidence(projectId, {
        sourceId: source.id,
        sourceVersionId: versionId,
        text: '片段',
        locator: { kind: 'page', page: -1 },
      }),
    ).rejects.toThrow('正整数')

    // 不属于本项目的来源
    expect(
      svc.extractEvidence(projectId, {
        sourceId: 'other-source',
        sourceVersionId: 'other-version',
        text: '片段',
        locator: { kind: 'page', page: 1 },
      }),
    ).rejects.toThrow('不属于本项目')

    // 版本不存在
    expect(
      svc.extractEvidence(projectId, {
        sourceId: source.id,
        sourceVersionId: 'wrong-version',
        text: '片段',
        locator: { kind: 'page', page: 1 },
      }),
    ).rejects.toThrow('来源版本不存在')

    expect(await svc.listEvidence(projectId)).toHaveLength(0)
  })

  test('agent-suggested 证据可入库并标记待确认', async () => {
    const { svc, source } = await setup()
    const projectId = source.projectId

    const evidence = await svc.extractEvidence(projectId, {
      sourceId: source.id,
      sourceVersionId: source.versions[0]!.id,
      text: 'Background info from abstract.',
      locator: { kind: 'section', label: 'Abstract' },
      extractionMode: 'agent-suggested',
    })
    expect(evidence.extractionMode).toBe('agent-suggested')
  })
})
