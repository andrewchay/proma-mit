import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 协议服务与访问守卫测试（M3 + G3）：
 * - 批准门禁：缺字段/缺检查项确认/缺伦理依据被阻断
 * - actor 由主进程确定，调用方无法自我批准
 * - 修订产生新版本，旧批准不沿用；已批准版本不能重复批准
 * - G3：非法/不存在 projectId 统一 NOT_FOUND（不泄露存在性）
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'protocol-service-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadAll() {
  return {
    svc: await import(`./protocol-service?t=${Math.random()}`),
    projectSvc: await import(`./research-service?t=${Math.random()}`),
    guard: await import(`./access-guard?t=${Math.random()}`),
  }
}

const AUDIOLOGY_FIELDS = {
  population: '成人感音神经性听损',
  intervention: '降噪 A',
  comparator: '降噪 B',
  outcomes: '语音识别阈值',
  acousticCalibration: '65 dB SPL 校准记录',
  estimand: '组间差值',
  samplingUnit: '受试者',
  sampleSizeRationale: '功效分析 0.8',
}
const AUDIOLOGY_CHECKS = ['ears-not-independent', 'unit-consistency', 'calibration-evidence', 'ceiling-floor']

async function setupAudiology() {
  const { svc, projectSvc } = await loadAll()
  const project = await projectSvc.createResearchProject({
    title: '协议测试项目',
    domain: 'audiology',
    methodPath: 'quantitative',
  })
  return { svc, projectId: project.id }
}

describe('G3 访问守卫', () => {
  test('非法或不存在 projectId 统一 NOT_FOUND，不泄露存在性', async () => {
    const { guard } = await loadAll()
    const loader = async () => null

    await expect(guard.assertProjectAccess('../etc/passwd', loader)).rejects.toThrow('不可访问')
    await expect(guard.assertProjectAccess('no-such-id', loader)).rejects.toThrow('不可访问')

    // 两种情况的错误码一致，避免区分
    const codes: string[] = []
    for (const id of ['../etc/passwd', 'no-such-id']) {
      try {
        await guard.assertProjectAccess(id, loader)
      } catch (err) {
        codes.push((err as { code: string }).code)
      }
    }
    expect(new Set(codes).size).toBe(1)
  })

  test('actor 不接受参数：始终由主进程确定为 local-user', async () => {
    const { guard } = await loadAll()
    expect(guard.currentActor().id).toBe('local-user')
    expect(guard.currentActor().trusted).toBe(true)
    // 函数签名无参数，调用方无法传入 actor
    expect(guard.currentActor.length).toBe(0)
  })

  test('服务层写操作对不可访问项目拒绝', async () => {
    const { svc } = await loadAll()
    await expect(
      svc.createProtocol('no-such-project', { methodPath: 'quantitative', fields: {} }),
    ).rejects.toThrow('不可访问')
  })
})

describe('协议创建与批准门禁', () => {
  test('创建草稿 v1；缺必填字段时批准被阻断', async () => {
    const { svc, projectId } = await setupAudiology()
    const protocol = await svc.createProtocol(projectId, {
      methodPath: 'quantitative',
      fields: { population: '成人' },
    })
    expect(protocol.version).toBe(1)
    expect(protocol.status).toBe('draft')

    await expect(
      svc.approveProtocol(projectId, 1, { acknowledgedChecks: AUDIOLOGY_CHECKS }),
    ).rejects.toThrow('不满足批准条件')
  })

  test('字段齐全但检查项未确认 → 阻断并说明', async () => {
    const { svc, projectId } = await setupAudiology()
    await svc.createProtocol(projectId, { methodPath: 'quantitative', fields: AUDIOLOGY_FIELDS })

    await expect(
      svc.approveProtocol(projectId, 1, { acknowledgedChecks: [] }),
    ).rejects.toThrow('检查项尚未确认')
  })

  test('字段齐全 + 检查项确认 → 批准成功，actor 为 local-user', async () => {
    const { svc, projectId } = await setupAudiology()
    await svc.createProtocol(projectId, { methodPath: 'quantitative', fields: AUDIOLOGY_FIELDS })

    const approved = await svc.approveProtocol(projectId, 1, {
      acknowledgedChecks: AUDIOLOGY_CHECKS,
      note: '方案可行',
    })
    expect(approved.status).toBe('approved')
    expect(approved.approval?.approvedBy.id).toBe('local-user')
    expect(approved.approval?.approvedBy.trusted).toBe(true)
  })

  test('已批准版本不能重复批准', async () => {
    const { svc, projectId } = await setupAudiology()
    await svc.createProtocol(projectId, { methodPath: 'quantitative', fields: AUDIOLOGY_FIELDS })
    await svc.approveProtocol(projectId, 1, { acknowledgedChecks: AUDIOLOGY_CHECKS })

    await expect(
      svc.approveProtocol(projectId, 1, { acknowledgedChecks: AUDIOLOGY_CHECKS }),
    ).rejects.toThrow('已批准')
  })

  test('已有未取代协议时禁止再建新协议（须走修订）', async () => {
    const { svc, projectId } = await setupAudiology()
    await svc.createProtocol(projectId, { methodPath: 'quantitative', fields: AUDIOLOGY_FIELDS })
    await expect(
      svc.createProtocol(projectId, { methodPath: 'quantitative', fields: AUDIOLOGY_FIELDS }),
    ).rejects.toThrow('修订协议')
  })

  test('质性研究缺伦理依据被阻断（通过 profile 条件必填）', async () => {
    const { svc, projectSvc } = await loadAll()
    const project = await projectSvc.createResearchProject({
      title: '医学人文项目',
      domain: 'medical-humanities',
      methodPath: 'qualitative',
    })
    await svc.createProtocol(project.id, {
      methodPath: 'qualitative',
      fields: {
        positionality: '临床背景',
        materialSelection: '招募 15 人',
        codingStrategy: '主题分析',
        dataRetention: '加密 5 年',
      },
    })

    await expect(
      svc.approveProtocol(project.id, 1, {
        acknowledgedChecks: ['no-fabricated-quotes', 'identity-separation', 'positionality-stated'],
      }),
    ).rejects.toThrow('伦理依据')
  })
})

describe('协议修订', () => {
  test('修订产生新版本，旧版本 superseded，旧批准不沿用', async () => {
    const { svc, projectId } = await setupAudiology()
    await svc.createProtocol(projectId, { methodPath: 'quantitative', fields: AUDIOLOGY_FIELDS })
    await svc.approveProtocol(projectId, 1, { acknowledgedChecks: AUDIOLOGY_CHECKS })

    const revised = await svc.reviseProtocol(projectId, {
      changeReason: '更换主要结局测量工具',
      methodPath: 'quantitative',
      fields: { ...AUDIOLOGY_FIELDS, outcomes: '语音识别阈值（新工具）' },
    })
    expect(revised.version).toBe(2)
    expect(revised.status).toBe('draft')
    expect(revised.changeReason).toContain('测量工具')

    const all = (await svc.listProtocols(projectId)) as Array<{ version: number; status: string }>
    expect(all.find((p) => p.version === 1)?.status).toBe('superseded')
    expect(all.find((p) => p.version === 2)?.status).toBe('draft')

    // 新版本需重新批准
    await expect(
      svc.approveProtocol(projectId, 2, { acknowledgedChecks: AUDIOLOGY_CHECKS }),
    ).resolves.toBeTruthy()
  })

  test('修订缺理由被拒绝', async () => {
    const { svc, projectId } = await setupAudiology()
    await svc.createProtocol(projectId, { methodPath: 'quantitative', fields: AUDIOLOGY_FIELDS })
    await svc.approveProtocol(projectId, 1, { acknowledgedChecks: AUDIOLOGY_CHECKS })

    await expect(
      svc.reviseProtocol(projectId, { changeReason: ' ', methodPath: 'quantitative', fields: AUDIOLOGY_FIELDS }),
    ).rejects.toThrow('变更理由')
  })

  test('最新协议查询返回最高版本', async () => {
    const { svc, projectId } = await setupAudiology()
    await svc.createProtocol(projectId, { methodPath: 'quantitative', fields: AUDIOLOGY_FIELDS })
    await svc.approveProtocol(projectId, 1, { acknowledgedChecks: AUDIOLOGY_CHECKS })
    await svc.reviseProtocol(projectId, {
      changeReason: '调整',
      methodPath: 'quantitative',
      fields: AUDIOLOGY_FIELDS,
    })
    const latest = await svc.getLatestProtocol(projectId)
    expect(latest?.version).toBe(2)
  })
})
