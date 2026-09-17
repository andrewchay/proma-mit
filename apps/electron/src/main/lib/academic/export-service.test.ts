import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 导出包测试（M7.2）：
 * - manifest 逐项标注验证等级，不做统一完成度分数
 * - 缺口显式列出（未确认主张、截断检索、未校验产物、无标识来源）
 * - 排除受限内容（全文、身份映射、凭据、日志原文）
 * - 关键边界声明：协议批准 ≠ 质量达标；进程完成 ≠ 结论成立
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'export-service-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadAll() {
  return {
    exportSvc: await import(`./export-service?t=${Math.random()}`),
    projectSvc: await import(`./research-service?t=${Math.random()}`),
    protocolSvc: await import(`./protocol-service?t=${Math.random()}`),
    sourceSvc: await import(`./source-service?t=${Math.random()}`),
    evidenceSvc: await import(`./evidence-service?t=${Math.random()}`),
    runSvc: await import(`./run-service?t=${Math.random()}`),
    claimSvc: await import(`./claim-service?t=${Math.random()}`),
  }
}

const AUDIOLOGY_FIELDS = {
  population: '成人听损', intervention: '降噪A', comparator: '降噪B', outcomes: 'SRT',
  acousticCalibration: '65 dB SPL', estimand: '差值', samplingUnit: '受试者', sampleSizeRationale: '功效0.8',
}
const AUDIOLOGY_CHECKS = ['ears-not-independent', 'unit-consistency', 'calibration-evidence', 'ceiling-floor']

/** 建一个信息较全的项目：协议已批准、有来源、有证据、有主张 */
async function setupRichProject() {
  const { projectSvc, protocolSvc, sourceSvc, evidenceSvc, claimSvc } = await loadAll()
  const project = await projectSvc.createResearchProject({
    title: '导出测试项目', domain: 'audiology', methodPath: 'quantitative',
  })

  const protocol = await protocolSvc.createProtocol(project.id, {
    methodPath: 'quantitative', fields: AUDIOLOGY_FIELDS,
  })
  await protocolSvc.approveProtocol(project.id, protocol.version, { acknowledgedChecks: AUDIOLOGY_CHECKS })

  const [source] = await sourceSvc.importBibliography(
    project.id, 'ris', 'TY  - JOUR\nTI  - Source A\nDO  - 10.1/a\nER  - \n',
  )
  const evidence = await evidenceSvc.extractEvidence(project.id, {
    sourceId: source!.id,
    sourceVersionId: source!.versions[0]!.id,
    text: '降噪显著降低聆听负荷',
    locator: { kind: 'page', page: 5 },
  })

  const claim = await claimSvc.createClaim(project.id, { text: '降噪降低聆听负荷', type: 'empirical' })
  await claimSvc.linkEvidence(project.id, { claimId: claim.id, relation: 'supports', evidenceId: evidence.id })

  return { projectId: project.id, claimId: claim.id, sourceId: source!.id }
}

describe('导出 manifest 构造', () => {
  test('逐项标注验证等级，不输出统一完成度分数', async () => {
    const { exportSvc, projectSvc, sourceSvc } = await loadAll()
    const project = await projectSvc.createResearchProject({
      title: 'P', domain: 'ai', methodPath: 'quantitative',
    })
    const [withId] = await sourceSvc.importBibliography(project.id, 'ris', 'TY  - JOUR\nTI  - A\nDO  - 10.1/x\nER  - \n')

    const manifest = exportSvc.buildExportManifest({
      project,
      sources: [withId!],
      searchRuns: [],
      evidence: [{ id: 'ev-1', sourceId: withId!.id, sourceVersionId: withId!.versions[0]!.id, text: '片段', locator: { kind: 'page' } }],
      observations: [],
      runs: [],
      artifacts: [],
      protocols: [],
      topics: [],
      claims: [],
      links: [],
      manuscripts: [],
      exportedAt: '2026-09-17T00:00:00.000Z',
    })

    const sourceEntry = (manifest.entries as Array<{ kind: string; verification: string; note?: string }>).find((e) => e.kind === 'source')!
    expect(sourceEntry.verification).toBe('verified')

    const evidenceEntry = (manifest.entries as Array<{ kind: string; verification: string }>).find((e) => e.kind === 'evidence')!
    expect(evidenceEntry.verification).toBe('verified')

    // 不提供任何"总分"字段
    expect(JSON.stringify(manifest)).not.toContain('overallScore')
    expect(JSON.stringify(manifest)).not.toContain('completionScore')
  })

  test('无标识来源标 unverified 并进缺口', async () => {
    const { exportSvc, projectSvc } = await loadAll()
    const project = await projectSvc.createResearchProject({ title: 'P', domain: 'medical-humanities', methodPath: 'qualitative' })

    const manifest = exportSvc.buildExportManifest({
      project,
      sources: [{
        id: 's1', projectId: project.id, type: 'book',
        versions: [{
          id: 's1-v1', sourceId: 's1', versionLabel: 'published', externalIds: [], title: '一本没有 DOI 的书',
          authors: ['作者'], retrievalStatus: 'metadata-only', retrievedAt: '2026-09-17T00:00:00.000Z',
        }],
        createdAt: 'x', updatedAt: 'x',
      }],
      searchRuns: [], evidence: [], observations: [], runs: [], artifacts: [],
      protocols: [], topics: [], claims: [], links: [], manuscripts: [],
    })

    const entry = (manifest.entries as Array<{ kind: string; verification: string; note?: string }>).find((e) => e.kind === 'source')!
    expect(entry.verification).toBe('unverified')
    expect(manifest.gaps.join(' ')).toContain('无外部标识')
  })

  test('截断检索、未校验产物、未确认主张都进缺口；批准附边界说明', async () => {
    const { exportSvc, projectSvc } = await loadAll()
    const project = await projectSvc.createResearchProject({ title: 'P', domain: 'audiology', methodPath: 'quantitative' })

    const manifest = exportSvc.buildExportManifest({
      project,
      sources: [],
      searchRuns: [{
        id: 'sr-1', projectId: project.id, query: 'hearing aid', databases: ['openalex'],
        startedAt: 'x', finishedAt: 'y', status: 'completed', resultCount: 20,
        importedSourceIds: [], truncated: true, errors: [],
      }],
      evidence: [], observations: [], runs: [],
      artifacts: [{
        id: 'ar-1', projectId: project.id, runId: 'r-1', ref: 'dvc:abc',
        integrity: 'unverified', recordedAt: 'x',
      }],
      protocols: [{
        id: 'pr-1', projectId: project.id, version: 1, status: 'approved', methodPath: 'quantitative',
        fields: AUDIOLOGY_FIELDS, acknowledgedChecks: AUDIOLOGY_CHECKS,
        createdAt: 'x', updatedAt: 'x',
        approval: { approvedBy: { id: 'local-user', displayName: '本机用户', trusted: true }, approvedAt: 'x' },
      }],
      topics: [],
      claims: [{
        id: 'c-1', projectId: project.id, text: '未确认的断言', type: 'empirical',
        status: 'needs_review', createdAt: 'x', updatedAt: 'x',
      }],
      links: [],
      manuscripts: [],
    })

    const gaps = manifest.gaps.join(' ')
    expect(gaps).toContain('结果被截断')
    expect(gaps).toContain('未校验产物')
    expect(gaps).toContain('主张未确认')
    // 批准 ≠ 质量达标
    expect((manifest.entries as Array<{ note?: string }>).some((e) => e.note?.includes('不代表研究质量已达标'))).toBe(true)
    // 进程完成 ≠ 结论成立（此处无运行，验证文案存在于运行分支的常量里）
    expect(exportSvc.renderExportReport(manifest)).toContain('不是对研究结论正确性的证明')
  })

  test('manifest 声明未包含的受限内容类型', async () => {
    const { exportSvc, projectSvc } = await loadAll()
    const project = await projectSvc.createResearchProject({ title: 'P', domain: 'ai', methodPath: 'quantitative' })
    const manifest = exportSvc.buildExportManifest({
      project, sources: [], searchRuns: [], evidence: [], observations: [], runs: [],
      artifacts: [], protocols: [], topics: [], claims: [], links: [], manuscripts: [],
    })

    const excluded = manifest.excluded.join(' ')
    expect(excluded).toContain('全文')
    expect(excluded).toContain('身份映射')
    expect(excluded).toContain('凭据')
    expect(excluded).toContain('日志原文')
  })
})

describe('导出落盘', () => {
  test('写出 manifest.json 与 report.md；不写全文/凭据', async () => {
    const { exportSvc, projectSvc } = await loadAll()
    const { projectId } = await setupRichProject()
    const outDir = join(tempDir, 'export-out')

    const bundle = await exportSvc.exportResearchBundle(projectId, {
      loadProject: (id: string) => projectSvc.getResearchProject(id),
      outputDir: outDir,
      exportedAt: '2026-09-17T00:00:00.000Z',
    })

    expect(existsSync(bundle.manifestPath)).toBe(true)
    expect(existsSync(bundle.reportPath)).toBe(true)

    const manifestRaw = readFileSync(bundle.manifestPath, 'utf-8')
    const manifest = JSON.parse(manifestRaw) as { counts: Record<string, number>; gaps: string[] }

    expect(manifest.counts.sources).toBe(1)
    expect(manifest.counts.evidence).toBe(1)
    expect(manifest.counts.claims).toBe(1)
    expect(manifest.counts.protocols).toBe(1)

    // 无敏感字段
    expect(manifestRaw).not.toContain('apiKey')
    expect(manifestRaw).not.toContain('token')
    expect(manifestRaw).not.toContain('secret')

    const report = readFileSync(bundle.reportPath, 'utf-8')
    expect(report).toContain('研究交付包')
    expect(report).toContain('未包含的内容')
    expect(report).toContain('不是对研究结论正确性的证明')

    // 只产生这两个文件（不复制全文或日志）
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(outDir).sort()).toEqual(['manifest.json', 'report.md'])
  })

  test('未确认主张会写入缺口，且导出仍可完成（导出不等于认证）', async () => {
    const { exportSvc, projectSvc } = await loadAll()
    const { projectId, claimId } = await setupRichProject()
    // 主张目前是 draft（未确认）
    const bundle = await exportSvc.exportResearchBundle(projectId, {
      loadProject: (id: string) => projectSvc.getResearchProject(id),
      outputDir: join(tempDir, 'export-out2'),
    })

    expect(bundle.manifest.gaps.join(' ')).toContain('主张未确认')
    expect((bundle.manifest.entries as Array<{ id: string; verification: string }>).some((e) => e.id === claimId && e.verification === 'unverified')).toBe(true)
  })

  test('不可访问的项目拒绝导出', async () => {
    const { exportSvc, projectSvc } = await loadAll()
    await expect(
      exportSvc.exportResearchBundle('no-such-project', {
        loadProject: (id: string) => projectSvc.getResearchProject(id),
      }),
    ).rejects.toThrow('不可访问')
  })
})

describe('导出报告渲染', () => {
  test('包含计数、缺口、验证等级表与排除声明', async () => {
    const { exportSvc, projectSvc } = await loadAll()
    const { projectId } = await setupRichProject()
    const bundle = await exportSvc.exportResearchBundle(projectId, {
      loadProject: (id: string) => projectSvc.getResearchProject(id),
      outputDir: join(tempDir, 'export-out3'),
    })
    const report = exportSvc.renderExportReport(bundle.manifest)

    expect(report).toContain('## 计数')
    expect(report).toContain('## 缺口与风险')
    expect(report).toContain('| 类型 | 标识 | 验证等级 | 说明 |')
    expect(report).toContain('## 未包含的内容')
  })
})
