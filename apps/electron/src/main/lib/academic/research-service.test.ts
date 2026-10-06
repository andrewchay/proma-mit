import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 研究项目应用服务测试（M1）。
 *
 * 覆盖方案 v1 §13.1 场景 3（越权/不存在不泄露）、4（协议修改留痕）
 * 的服务层基础，以及状态机经服务层的端到端行为。
 * 全部在 PROMA_TEST_CONFIG_DIR 隔离，不触碰 ~/.gravitas/。
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'research-service-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadService() {
  return import(`./research-service?t=${Math.random()}`)
}

const brief = { question: '两种降噪策略哪种更优？', goals: '比较效应', scope: '成人听损人群' }

describe('research-service 项目生命周期', () => {
  test('创建 → 读取 → 列表', async () => {
    const svc = await loadService()
    const project = await svc.createResearchProject({
      title: '降噪策略研究',
      domain: 'audiology',
      methodPath: 'quantitative',
      brief,
    })

    expect(project.id).toBeTruthy()
    expect(project.status).toBe('defining')
    expect(project.revision).toBe(1)
    expect((await svc.getResearchProject(project.id))?.title).toBe('降噪策略研究')
    expect((await svc.listResearchProjects()).map((p: { id: string }) => p.id)).toContain(project.id)
  })

  test('不存在的项目返回 null 而非泄露信息', async () => {
    const svc = await loadService()
    expect(await svc.getResearchProject('nope')).toBeNull()
  })

  test('非法输入被拒绝', async () => {
    const svc = await loadService()
    expect(
      svc.createResearchProject({ title: '', domain: 'ai', methodPath: 'quantitative' }),
    ).rejects.toThrow('标题不能为空')
  })

  test('状态推进走状态机：defining → literature → designing', async () => {
    const svc = await loadService()
    const project = await svc.createResearchProject({
      title: '状态机研究',
      domain: 'statistics',
      methodPath: 'quantitative',
    })

    await svc.changeResearchStatus(project.id, 'literature')
    const p2 = await svc.changeResearchStatus(project.id, 'designing')
    expect(p2.status).toBe('designing')
    expect(p2.revision).toBe(3)
  })

  test('跳阶段被拒绝且项目状态不变', async () => {
    const svc = await loadService()
    const project = await svc.createResearchProject({
      title: '跳阶段研究',
      domain: 'ai',
      methodPath: 'quantitative',
    })

    expect(
      svc.changeResearchStatus(project.id, 'executing'),
    ).rejects.toThrow('非法研究状态迁移')
    expect((await svc.getResearchProject(project.id))?.status).toBe('defining')
  })

  test('Brief 更新留痕（revision 递增）', async () => {
    const svc = await loadService()
    const project = await svc.createResearchProject({
      title: 'Brief 留痕',
      domain: 'medical-humanities',
      methodPath: 'qualitative',
    })

    const updated = await svc.updateResearchBrief(
      project.id,
      { question: '听损者的身份认同如何被设备塑造？', goals: '质性探索', scope: '访谈研究' },
      '精化研究问题',
    )
    expect(updated.revision).toBe(2)
    expect(updated.brief?.question).toContain('身份认同')
  })

  test('无理由的 Brief 修改被拒绝', async () => {
    const svc = await loadService()
    const project = await svc.createResearchProject({
      title: '无理由修改',
      domain: 'ontology',
      methodPath: 'formal',
    })

    expect(
      svc.updateResearchBrief(project.id, { question: 'q', goals: 'g', scope: 's' }, ' '),
    ).rejects.toThrow('理由')
  })

  test('归档后不可再变更', async () => {
    const svc = await loadService()
    const project = await svc.createResearchProject({
      title: '归档研究',
      domain: 'enterprise-ai',
      methodPath: 'mixed-practice',
    })

    const archived = await svc.archiveResearchProject(project.id, '暂停')
    expect(archived.status).toBe('archived')
    expect(
      svc.changeResearchStatus(project.id, 'literature'),
    ).rejects.toThrow('非法研究状态迁移')
  })

  test('七个方向都能合法创建（方案 §5 验收基础）', async () => {
    const svc = await loadService()
    const domains = [
      'audiology', 'medical-humanities', 'statistics', 'ai',
      'ontology', 'enterprise-ai', 'data-science',
    ] as const
    for (const domain of domains) {
      const p = await svc.createResearchProject({
        title: `${domain} 样例`,
        domain,
        methodPath: domain === 'medical-humanities' ? 'qualitative' : domain === 'ontology' ? 'formal' : 'quantitative',
      })
      expect(p.status).toBe('defining')
    }
  })
})
