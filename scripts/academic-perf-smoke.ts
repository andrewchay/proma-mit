/**
 * 学术研究模块性能压测（M7）
 *
 *   bun scripts/academic-perf-smoke.ts
 *
 * 目标量级（方案 §13.3）：单项目 5,000 条书目、50,000 条证据片段、
 * 1,000 次运行。**实测数值打印出来，不在代码里写死延迟门限**——
 * 门限待 M1 实测基线后锁定（方案 §13.3 原文要求）。
 *
 * 用隔离的临时配置目录，不触碰真实数据。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'academic-perf-'))
process.env.PROMA_TEST_CONFIG_DIR = tempDir

const SOURCE_COUNT = 5000
const EVIDENCE_COUNT = 50_000
const RUN_COUNT = 1000

interface Timing {
  label: string
  ms: number
  detail?: string
}

const timings: Timing[] = []

async function timed(label: string, detail: string, fn: () => Promise<void> | void): Promise<void> {
  const start = performance.now()
  await fn()
  timings.push({ label, ms: Math.round(performance.now() - start), detail })
}

async function main(): Promise<void> {
  const store = await import('../apps/electron/src/main/lib/academic/research-store')
  const research = await import('../apps/electron/src/main/lib/academic/research-service')

  const project = await research.createResearchProject({
    title: '性能压测项目',
    domain: 'audiology',
    methodPath: 'quantitative',
  })

  // 直接经 store 写入事件，测的是事件流与重放的真实成本
  await timed('写入 5,000 条来源', `≈${SOURCE_COUNT} 事件`, async () => {
    for (let i = 0; i < SOURCE_COUNT; i++) {
      await store.appendEvent(project.id, {
        commandId: `perf-source-${i}`,
        payload: {
          type: 'source_imported',
          origin: 'search',
          source: {
            id: `src-${i}`,
            projectId: project.id,
            type: 'journal-article',
            versions: [
              {
                id: `src-${i}-v1`, sourceId: `src-${i}`, versionLabel: 'published',
                externalIds: [{ namespace: 'doi', value: `10.1/${i}` }],
                title: `Performance source ${i}`, authors: ['A'], retrievalStatus: 'abstract-only',
                retrievedAt: '2026-09-17T00:00:00.000Z',
              },
            ],
            createdAt: '2026-09-17T00:00:00.000Z',
            updatedAt: '2026-09-17T00:00:00.000Z',
          },
        } as never,
      })
    }
  })

  await timed('写入 50,000 条证据', `≈${EVIDENCE_COUNT} 事件`, async () => {
    for (let i = 0; i < EVIDENCE_COUNT; i++) {
      await store.appendEvent(project.id, {
        commandId: `perf-ev-${i}`,
        payload: {
          type: 'evidence_extracted',
          evidence: {
            id: `ev-${i}`, projectId: project.id, sourceId: `src-${i % SOURCE_COUNT}`,
            sourceVersionId: `src-${i % SOURCE_COUNT}-v1`, text: `证据片段 ${i}`,
            locator: { kind: 'page', page: (i % 500) + 1 }, extractionMode: 'manual',
            createdAt: '2026-09-17T00:00:00.000Z',
          },
        } as never,
      })
    }
  })

  await timed('写入 1,000 次运行', `≈${RUN_COUNT} 事件`, async () => {
    for (let i = 0; i < RUN_COUNT; i++) {
      await store.appendEvent(project.id, {
        commandId: `perf-run-${i}`,
        payload: {
          type: 'run_recorded',
          run: {
            id: `run-${i}`, projectId: project.id, kind: 'compute', status: 'completed',
            title: `运行 ${i}`, input: {}, budget: { timeoutMs: 1000, maxOutputBytes: 1024 },
            createdAt: '2026-09-17T00:00:00.000Z',
          },
        } as never,
      })
    }
  })

  await timed('重放项目状态（全量事件）', 'loadProjectState', async () => {
    await store.loadProjectState(project.id)
  })

  await timed('按类型聚合视图（证据台账）', 'readProjectEvents + filter', async () => {
    const events = await store.readProjectEvents(project.id)
    const evidence = events.filter((e) => e.payload.type === 'evidence_extracted')
    if (evidence.length !== EVIDENCE_COUNT) {
      throw new Error(`证据条数不符：期望 ${EVIDENCE_COUNT}，实际 ${evidence.length}`)
    }
  })

  await timed('列出研究项目', 'research.listResearchProjects', async () => {
    await research.listResearchProjects()
  })

  console.log('\n=== 学术研究模块性能压测（隔离临时目录）===')
  for (const t of timings) {
    console.log(`${t.label.padEnd(24)} ${String(t.ms).padStart(7)} ms   ${t.detail ?? ''}`)
  }
  console.log('\n说明：以上为实测数值，未设置通过/失败门限；')
  console.log('门限应在真实基线与目标硬件确定后锁定（方案 §13.3）。')
}

try {
  await main()
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
