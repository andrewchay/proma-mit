/**
 * 学术检索 adapter 真实端点 smoke（G4）
 *
 * 不进测试套件：联网、依赖外部服务可用性，必须显式执行。
 *
 *   bun scripts/academic-adapter-smoke.ts            # 全部公开源
 *   bun scripts/academic-adapter-smoke.ts openalex arxiv
 *
 * 结果只报告「通/不通/字段是否如预期」，失败不视为代码缺陷的自动结论；
 * 若端点变更或限流，需人工判断。
 */

import { createOpenAlexAdapter } from '../apps/electron/src/main/lib/academic/adapters/openalex-adapter'
import { createArxivAdapter } from '../apps/electron/src/main/lib/academic/adapters/arxiv-adapter'
import { createPubmedAdapter } from '../apps/electron/src/main/lib/academic/adapters/pubmed-adapter'
import { createEuropePmcAdapter } from '../apps/electron/src/main/lib/academic/adapters/europepmc-adapter'
import type { ScholarAdapter } from '../apps/electron/src/main/lib/academic/adapters/adapter-types'

const QUERY = 'noise reduction hearing aid listening effort'
const LIMIT = 5

const FACTORIES: Record<string, () => ScholarAdapter> = {
  openalex: () => createOpenAlexAdapter(fetch),
  arxiv: () => createArxivAdapter(fetch),
  pubmed: () => createPubmedAdapter(fetch),
  europepmc: () => createEuropePmcAdapter(fetch),
}

const requested = process.argv.slice(2)
const targets = requested.length > 0 ? requested : Object.keys(FACTORIES)

interface Outcome {
  database: string
  ok: boolean
  count: number
  totalCount?: number
  truncated?: boolean
  errors: string[]
  firstTitle?: string
  retrievalStatus?: string
  durationMs: number
}

async function run(): Promise<void> {
  const outcomes: Outcome[] = []

  for (const name of targets) {
    const factory = FACTORIES[name]
    if (!factory) {
      console.error(`未知数据库: ${name}（可选: ${Object.keys(FACTORIES).join(', ')}）`)
      continue
    }

    const started = Date.now()
    try {
      const adapter = factory()
      const result = await adapter.search(QUERY, { limit: LIMIT })
      const first = result.sources[0]
      const ok = result.sources.length > 0 && (!first || first.title.length > 0) && !first?.sourceId
      outcomes.push({
        database: name,
        ok,
        count: result.sources.length,
        totalCount: result.totalCount,
        truncated: result.truncated,
        errors: result.errors,
        firstTitle: first?.title,
        retrievalStatus: first?.retrievalStatus,
        durationMs: Date.now() - started,
      })
    } catch (err) {
      outcomes.push({
        database: name,
        ok: false,
        count: 0,
        errors: [err instanceof Error ? err.message : String(err)],
        durationMs: Date.now() - started,
      })
    }
  }

  console.log('\n=== 学术检索 adapter 真实端点 smoke ===')
  console.log(`检索词: ${QUERY}\n`)
  for (const o of outcomes) {
    const mark = o.ok ? 'PASS' : 'FAIL'
    console.log(`[${mark}] ${o.database}  ${o.durationMs}ms`)
    console.log(`  结果: ${o.count} 条${o.totalCount !== undefined ? `（全库命中 ${o.totalCount}）` : ''}${o.truncated ? ' · 已截断' : ''}`)
    if (o.firstTitle) console.log(`  首条: ${o.firstTitle.slice(0, 80)}`)
    if (o.retrievalStatus) console.log(`  获取等级: ${o.retrievalStatus}`)
    for (const e of o.errors) console.log(`  错误: ${e}`)
  }

  const failed = outcomes.filter((o) => !o.ok)
  console.log(`\n合计 ${outcomes.length} 个源，通过 ${outcomes.length - failed.length}，未通过 ${failed.length}`)
  if (failed.length > 0) {
    console.log('未通过可能来自端点变更、限流或网络限制，需人工判断；不得据此宣称集成已完成。')
  }
}

void run()
