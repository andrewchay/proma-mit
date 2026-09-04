import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface DirectoryToolResult {
  content: string
  isError?: boolean
}

type DirectoryToolExecute = (input: unknown) => Promise<DirectoryToolResult>

interface MarketingDirectoryExecutors {
  strategy: DirectoryToolExecute
  contentAudit: DirectoryToolExecute
  kolSearch: DirectoryToolExecute
  creativeBrief: DirectoryToolExecute
  matchKols: DirectoryToolExecute
  budgetForecast: DirectoryToolExecute
  campaignGet: DirectoryToolExecute
  campaignOptimizer: DirectoryToolExecute
  phaseReport: DirectoryToolExecute
}

const testDir = join(tmpdir(), `proma-directory-tools-${Date.now()}`)
const marketingToolsRoot = join(import.meta.dir, '../../../../../default-tools/marketing')
let executors: MarketingDirectoryExecutors

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  rmSync(testDir, { recursive: true, force: true })
  mkdirSync(testDir, { recursive: true })

  // 必须在测试配置目录就绪后动态导入，避免 Campaign 模块初始化用户真实本地数据。
  const [strategy, contentAudit, kolSearch, creativeBrief, matchKols, budgetForecast, campaignGet, campaignOptimizer, phaseReport] = await Promise.all([
    import('../../../../../default-tools/marketing/paid-media/strategy-iq/execute'),
    import('../../../../../default-tools/marketing/influencer/content-audit/execute'),
    import('../../../../../default-tools/marketing/influencer/kol-search/execute'),
    import('../../../../../default-tools/marketing/influencer/creative-pilot/execute'),
    import('../../../../../default-tools/marketing/influencer/match-ai/execute'),
    import('../../../../../default-tools/marketing/paid-media/budget-forecast/execute'),
    import('../../../../../default-tools/marketing/paid-media/campaign-agent/execute'),
    import('../../../../../default-tools/marketing/paid-media/campaign-optimizer/execute'),
    import('../../../../../default-tools/marketing/paid-media/ma-phase-reviewer/execute'),
  ])
  executors = {
    strategy: strategy.execute,
    contentAudit: contentAudit.execute,
    kolSearch: kolSearch.execute,
    creativeBrief: creativeBrief.execute,
    matchKols: matchKols.execute,
    budgetForecast: budgetForecast.execute,
    campaignGet: campaignGet.execute,
    campaignOptimizer: campaignOptimizer.execute,
    phaseReport: phaseReport.execute,
  }
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(testDir, { recursive: true, force: true })
})

describe('营销工具目录执行绑定', () => {
  it('每个目录化营销工具都声明 execute.ts，不能静默回退到中心映射', () => {
    const toolDirectories = findToolDirectories(marketingToolsRoot)
    expect(toolDirectories).toHaveLength(26)
    for (const toolDirectory of toolDirectories) {
      expect(existsSync(join(toolDirectory, 'execute.ts'))).toBe(true)
    }
  })

  it('策略生成目录执行器保留底层参数错误语义', async () => {
    const result = await executors.strategy({})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('brand')
  })

  it('内容审核目录执行器使用 content_description 真实契约', async () => {
    const result = await executors.contentAudit({ brand: 'Proma', product: '面膜', content: '旧字段不应通过' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('content_description')
  })

  it('KOL 搜索目录执行器保留底层错误语义', async () => {
    const result = await executors.kolSearch({ action: 'unknown-action' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('未知操作类型')
  })

  it('新增目录工具保留既有实现的参数失败语义', async () => {
    const modules = await Promise.all([
      import('../../../../../default-tools/marketing/influencer/connect-bot/execute'),
      import('../../../../../default-tools/marketing/influencer/kol-crm/execute'),
      import('../../../../../default-tools/marketing/influencer/kol-portal/execute'),
      import('../../../../../default-tools/marketing/influencer/script-studio/execute'),
      import('../../../../../default-tools/marketing/paid-media/campaign-tester/execute'),
      import('../../../../../default-tools/marketing/paid-media/content-performance/execute'),
      import('../../../../../default-tools/marketing/paid-media/traffic-strategy/execute'),
      import('../../../../../default-tools/marketing/paid-media/content-tracking/execute'),
    ])
    const results = await Promise.all(modules.map((module) => module.execute({})))
    for (const result of results) expect(result.isError).toBe(true)
    expect(results[0]?.content).toContain('kol_name')
    expect(results[1]?.content).toContain('action')
    expect(results[2]?.content).toContain('action')
    expect(results[3]?.content).toContain('brand')
    expect(results[4]?.content).toContain('brand')
    expect(results[5]?.content).toContain('content_id')
    expect(results[6]?.content).toContain('content_id')
    expect(results[7]?.content).toContain('campaign_id')
    const benchmarks = await import('../../../../../default-tools/marketing/paid-media/content-benchmarks/execute')
    expect(typeof benchmarks.execute).toBe('function')
  })
  it('下一批目录执行器都能抵达对应业务契约', async () => {
    const results = await Promise.all([
      executors.creativeBrief({}),
      executors.matchKols({}),
      executors.budgetForecast({}),
      executors.campaignGet({ campaign_id: 'missing' }),
      executors.campaignOptimizer({}),
      executors.phaseReport({}),
    ])
    for (const result of results) expect(result.isError).toBe(true)
    expect(results[0]?.content).toContain('platform')
    expect(results[2]?.content).toContain('market_size')
    expect(results[4]?.content).toContain('test_results')
    expect(results[5]?.content).toContain('start_date')
  })
})

function findToolDirectories(root: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (!entry.isDirectory()) continue
    if (existsSync(join(path, 'tool.json'))) result.push(path)
    result.push(...findToolDirectories(path))
  }
  return result
}
