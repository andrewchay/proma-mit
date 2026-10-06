import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 主张与稿件服务测试（M5.1）：
 * - 证据关联必须指向真实对象（伪造 id 拒绝）
 * - 无支持证据不得人工确认；有反对证据应标 contested
 * - 失效传播把相关主张标 stale
 * - 稿件版本递增且引用主张必须存在
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'claim-service-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadAll() {
  return {
    claim: await import(`./claim-service?t=${Math.random()}`),
    project: await import(`./research-service?t=${Math.random()}`),
    source: await import(`./source-service?t=${Math.random()}`),
    evidence: await import(`./evidence-service?t=${Math.random()}`),
    run: await import(`./run-service?t=${Math.random()}`),
  }
}

/** 建项目 + 一条证据片段，返回关键 id */
async function setupWithEvidence() {
  const { claim, project, source, evidence } = await loadAll()
  const p = await project.createResearchProject({
    title: '主张测试项目', domain: 'audiology', methodPath: 'quantitative',
  })
  const [src] = await source.importBibliography(
    p.id, 'ris', 'TY  - JOUR\nTI  - Evidence Source\nER  - \n',
  )
  const ev = await evidence.extractEvidence(p.id, {
    sourceId: src!.id,
    sourceVersionId: src!.versions[0]!.id,
    text: '降噪显著降低聆听负荷（p<0.01）',
    locator: { kind: 'page', page: 3 },
  })
  return { claim, projectId: p.id, evidenceId: ev.id, workdir: join(tempDir, 'academic', 'research', p.id, 'workdir') }
}

describe('主张创建与证据关联', () => {
  test('创建主张并关联真实证据', async () => {
    const { claim, projectId, evidenceId } = await setupWithEvidence()
    const created = await claim.createClaim(projectId, { text: '降噪降低聆听负荷', type: 'empirical' })
    expect(created.status).toBe('draft')

    const link = await claim.linkEvidence(projectId, { claimId: created.id, relation: 'supports', evidenceId })
    expect(link.createdBy.id).toBe('local-user')

    const views = await claim.listClaims(projectId)
    expect(views[0]!.summary.supports).toBe(1)
    expect(views[0]!.summary.canBeVerified).toBe(true)
  })

  test('伪造证据/运行 id 被拒绝（必须真实存在）', async () => {
    const { claim, projectId } = await setupWithEvidence()
    const created = await claim.createClaim(projectId, { text: '断言', type: 'empirical' })

    await expect(
      claim.linkEvidence(projectId, { claimId: created.id, relation: 'supports', evidenceId: 'ghost' }),
    ).rejects.toThrow('证据片段不存在')

    await expect(
      claim.linkEvidence(projectId, { claimId: created.id, relation: 'supports', runId: 'ghost-run' }),
    ).rejects.toThrow('运行记录不存在')

    await expect(
      claim.linkEvidence(projectId, { claimId: 'ghost-claim', relation: 'supports', evidenceId: 'x' }),
    ).rejects.toThrow('主张不存在')
  })

  test('无对象的纯文字依据被拒绝', async () => {
    const { claim, projectId } = await setupWithEvidence()
    const created = await claim.createClaim(projectId, { text: '断言', type: 'empirical' })
    await expect(
      claim.linkEvidence(projectId, { claimId: created.id, relation: 'supports' }),
    ).rejects.toThrow('必须指向真实对象')
  })
})

describe('人工确认门禁', () => {
  test('无支持证据不得确认', async () => {
    const { claim, projectId } = await setupWithEvidence()
    const created = await claim.createClaim(projectId, { text: '无证据断言', type: 'theoretical' })

    await expect(
      claim.setClaimStatus(projectId, created.id, 'researcher_verified'),
    ).rejects.toThrow('没有任何支持证据')
  })

  test('有反对证据时拒绝确认，并建议 contested', async () => {
    const { claim, projectId, evidenceId } = await setupWithEvidence()
    const created = await claim.createClaim(projectId, { text: '有争议断言', type: 'empirical' })
    await claim.linkEvidence(projectId, { claimId: created.id, relation: 'supports', evidenceId })
    await claim.linkEvidence(projectId, { claimId: created.id, relation: 'opposes', evidenceId })

    await expect(
      claim.setClaimStatus(projectId, created.id, 'researcher_verified'),
    ).rejects.toThrow('contested')

    const contested = await claim.setClaimStatus(projectId, created.id, 'contested')
    expect(contested.status).toBe('contested')
  })

  test('有支持证据时可确认，且记录确认人', async () => {
    const { claim, projectId, evidenceId } = await setupWithEvidence()
    const created = await claim.createClaim(projectId, { text: '可确认断言', type: 'empirical' })
    await claim.linkEvidence(projectId, { claimId: created.id, relation: 'supports', evidenceId })

    await claim.setClaimStatus(projectId, created.id, 'needs_review')
    const verified = await claim.setClaimStatus(projectId, created.id, 'researcher_verified', { note: '已核对原文' })
    expect(verified.status).toBe('researcher_verified')
    expect(verified.verification?.verifiedBy.id).toBe('local-user')
  })
})

describe('失效传播', () => {
  test('证据撤回把相关主张标 stale；未关联的不受影响', async () => {
    const { claim, projectId, evidenceId } = await setupWithEvidence()
    const a = await claim.createClaim(projectId, { text: '依赖该证据', type: 'empirical' })
    const b = await claim.createClaim(projectId, { text: '不依赖', type: 'theoretical' })
    await claim.linkEvidence(projectId, { claimId: a.id, relation: 'supports', evidenceId })

    const result = await claim.propagateInvalidation(projectId, {
      evidenceIds: [evidenceId],
      reason: '来源版本更新',
    })
    expect(result.affectedClaimIds).toEqual([a.id])

    const views = (await claim.listClaims(projectId)) as Array<{ id: string; status: string; staleReason?: string }>
    expect(views.find((v) => v.id === a.id)?.status).toBe('stale')
    expect(views.find((v) => v.id === a.id)?.staleReason).toContain('来源版本更新')
    expect(views.find((v) => v.id === b.id)?.status).toBe('draft')
  })

  test('失效传播必须说明原因', async () => {
    const { claim, projectId } = await setupWithEvidence()
    await expect(
      claim.propagateInvalidation(projectId, { evidenceIds: ['x'], reason: ' ' }),
    ).rejects.toThrow('必须说明原因')
  })
})

describe('导出预检与稿件版本', () => {
  test('预检逐条列出问题；确认后通过', async () => {
    const { claim, projectId, evidenceId } = await setupWithEvidence()
    const created = await claim.createClaim(projectId, { text: '结论', type: 'empirical' })

    const before = await claim.runExportPreflight(projectId)
    expect(before.ok).toBe(false)
    expect(before.items[0]!.issue).toContain('没有支持证据')

    await claim.linkEvidence(projectId, { claimId: created.id, relation: 'supports', evidenceId })
    await claim.setClaimStatus(projectId, created.id, 'needs_review')
    await claim.setClaimStatus(projectId, created.id, 'researcher_verified')

    const after = await claim.runExportPreflight(projectId)
    expect(after.ok).toBe(true)
  })

  test('稿件版本递增；新版需变更理由；引用不存在的主张拒绝', async () => {
    const { claim, projectId } = await setupWithEvidence()
    const c = await claim.createClaim(projectId, { text: '结论', type: 'empirical' })

    const v1 = await claim.createManuscriptVersion(projectId, {
      title: '初稿',
      sections: [{ heading: '引言', content: '背景…', claimIds: [c.id] }],
    })
    expect(v1.version).toBe(1)
    expect(v1.createdBy.id).toBe('local-user')

    await expect(
      claim.createManuscriptVersion(projectId, { title: '改稿', sections: [{ heading: '引言', content: 'x' }] }),
    ).rejects.toThrow('变更理由')

    const v2 = await claim.createManuscriptVersion(projectId, {
      title: '改稿',
      sections: [{ heading: '引言', content: 'x' }],
      changeReason: '调整引言结构',
    })
    expect(v2.version).toBe(2)

    await expect(
      claim.createManuscriptVersion(projectId, {
        title: '引用错误',
        sections: [{ heading: '引言', content: 'x', claimIds: ['ghost'] }],
        changeReason: 'x',
      }),
    ).rejects.toThrow('主张不存在')

    const latest = await claim.getLatestManuscript(projectId)
    expect(latest?.version).toBe(2)
  })
})
