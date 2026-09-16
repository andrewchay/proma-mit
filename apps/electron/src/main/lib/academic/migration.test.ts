import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 旧论文迁移 dry-run 测试（方案 §10.3 第 1 步）。
 *
 * 只读预检不写新数据；损坏索引转为 warning 而不是静默当空库。
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'research-migration-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadMigration() {
  return import(`./migration?t=${Math.random()}`)
}

function writeLegacyPapers(payload: unknown): void {
  const dir = join(tempDir, 'academic')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'papers.json'), JSON.stringify(payload), 'utf8')
}

describe('旧论文迁移 dry-run', () => {
  test('无旧数据时报告 exists=false 且无需迁移', async () => {
    const migration = await loadMigration()
    const report = migration.dryRunLegacyPapersMigration()
    expect(report.exists).toBe(false)
    expect(report.totalPapers).toBe(0)
  })

  test('完整旧论文映射为 migrate，并检查产出物存在性', async () => {
    const dir = join(tempDir, 'academic', 'artifacts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'paper-1-integrity.json'), '{"overallScore": 90}', 'utf8')
    writeLegacyPapers({
      papers: [
        {
          id: 'paper-1',
          title: '旧论文',
          content: '正文内容',
          keywords: [],
          stages: [{ stage: 'research', status: 'completed', artifactRefs: [] }],
          currentStage: 'write',
          revisionRound: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })

    const migration = await loadMigration()
    const report = migration.dryRunLegacyPapersMigration()
    expect(report.totalPapers).toBe(1)
    expect(report.mappings[0].action).toBe('migrate')
    expect(report.mappings[0].legacyArtifacts).toEqual([
      { kind: 'integrity', exists: true },
      { kind: 'peer-review', exists: false },
      { kind: 'revision', exists: false },
    ])
  })

  test('缺正文的旧论文标为 needs_review，不推断补造', async () => {
    writeLegacyPapers({
      papers: [
        {
          id: 'paper-2',
          title: '空正文',
          content: '',
          keywords: [],
          stages: [],
          currentStage: 'research',
          revisionRound: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })

    const migration = await loadMigration()
    const report = migration.dryRunLegacyPapersMigration()
    expect(report.mappings[0].action).toBe('needs_review')
    expect(report.mappings[0].missing).toContain('content')
  })

  test('损坏索引转为 warning，dry-run 不阻断也不覆盖', async () => {
    const dir = join(tempDir, 'academic')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'papers.json'), '{broken', 'utf8')

    const migration = await loadMigration()
    const report = migration.dryRunLegacyPapersMigration()
    expect(report.readable).toBe(false)
    expect(report.warnings[0]).toContain('损坏')
    expect(report.totalPapers).toBe(0)
  })
})
