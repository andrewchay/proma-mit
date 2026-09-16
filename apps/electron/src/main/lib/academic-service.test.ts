import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string
const originalEnv = { ...process.env }

async function loadService() {
  return import(`./academic-service?t=${Math.random()}`)
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'academic-service-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

describe('学术助手服务持久化与阶段状态', () => {
  test('完整性报告保存到论文项目后可被后续阶段读取', async () => {
    const svc = await loadService()
    const paper = svc.createPaper({
      title: '完整性检查持久化',
      content: '这是一个足够长的研究正文。'.repeat(30),
    })

    await svc.advanceStage(paper.id) // research → write
    await svc.advanceStage(paper.id) // write → integrity
    const result = await svc.advanceStage(paper.id) // integrity

    expect(result.executedStage).toBe('integrity')
    expect(svc.getIntegrityReport(paper.id)).not.toBeNull()
  })

  test('Markdown 方法章节被适配给同行评审，而不是一律标记为 body', async () => {
    const svc = await loadService()
    const sections = svc.parsePaperSections(
      `\n# 引言
${'背景。'.repeat(30)}

## 方法
本研究纳入 120 participants，设置 control 组，使用 regression 统计分析，并公开代码和数据。
${'方法细节。'.repeat(40)}

## 结果
${'结果。'.repeat(30)}
`,
    ) as Array<{ type: string; content: string }>

    expect(sections.find((section) => section.type === 'method')?.content).toContain('120 participants')
  })

  test('finalize 阶段可显式完成，不再因不存在下一阶段而抛错', async () => {
    const svc = await loadService()
    const paper = svc.createPaper({ title: '最终交付', content: '正文' })
    const stored = svc.getPaper(paper.id)!
    stored.currentStage = 'finalize'
    // 通过公开更新路径构造前置阶段；测试只验证 final 状态机行为。
    for (const stage of stored.stages as Array<{ stage: string; status: string }>) {
      if (stage.stage !== 'finalize') stage.status = 'completed'
    }
    writeFileSync(join(tempDir, 'academic', 'papers.json'), JSON.stringify({ papers: [stored] }), 'utf8')

    const result = await svc.advanceStage(paper.id)

    expect(result.executedStage).toBe('finalize')
    expect(result.paper.currentStage).toBe('finalize')
    expect(result.paper.stages.find((stage: { stage: string; status: string }) => stage.stage === 'finalize')?.status).toBe('completed')
  })

  test('损坏的论文索引拒绝读写，且不覆盖原始文件', async () => {
    const svc = await loadService()
    const academicDir = join(tempDir, 'academic')
    const papersPath = join(academicDir, 'papers.json')
    // getAcademicDir 在服务第一次访问时创建目录。
    svc.listPapers()
    writeFileSync(papersPath, '{not valid json', 'utf8')

    expect(() => svc.createPaper({ title: '不应覆盖' })).toThrow('论文索引损坏')
    expect(readFileSync(papersPath, 'utf8')).toBe('{not valid json')
    expect(existsSync(papersPath)).toBe(true)
  })
})
