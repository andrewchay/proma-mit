/**
 * 评测结果查看脚本
 *
 * 检查现有 scoreboard 数据，或创建模拟评测结果用于验证流程。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG_DIR = process.env.HOME + '/.gravitas'

function readScoreboard(benchmarkId: string) {
  const path = join(CONFIG_DIR, 'eval', 'benchmarks', benchmarkId, 'scoreboard.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function readBenchmark(benchmarkId: string) {
  const path = join(CONFIG_DIR, 'eval', 'benchmarks', benchmarkId, 'benchmark.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

console.log('📊 工具集评测状态检查\n')

// 检查 marketing-toolset
console.log('=== Marketing Toolset ===')
const marketingBenchmark = readBenchmark('marketing-toolset')
const marketingScoreboard = readScoreboard('marketing-toolset')

if (marketingBenchmark) {
  console.log(`✅ Benchmark 配置存在`)
  console.log(`   目标: ${marketingBenchmark.targetType} / ${marketingBenchmark.targetAgentId}`)
  console.log(`   期望分数: ${marketingBenchmark.targetScore}`)
  console.log(`   Cases: ${marketingBenchmark.cases.join(', ')}`)
} else {
  console.log('❌ Benchmark 配置不存在')
}

if (marketingScoreboard) {
  console.log(`✅ Scoreboard 存在 (${marketingScoreboard.evaluations?.length || 0} 条记录)`)
  if (marketingScoreboard.evaluations?.length > 0) {
    const latest = marketingScoreboard.evaluations[marketingScoreboard.evaluations.length - 1]
    console.log(`   最新分数: ${latest.score} (版本 ${latest.agentVersion})`)
    console.log(`   时间: ${latest.time}`)
  }
} else {
  console.log('⬜ Scoreboard 不存在（尚未运行评测）')
}

console.log('')

// 检查 computer-use
console.log('=== Computer Use ===')
const computerBenchmark = readBenchmark('computer-use')
const computerScoreboard = readScoreboard('computer-use')

if (computerBenchmark) {
  console.log(`✅ Benchmark 配置存在`)
  console.log(`   目标: ${computerBenchmark.targetType} / ${computerBenchmark.targetAgentId}`)
  console.log(`   期望分数: ${computerBenchmark.targetScore}`)
  console.log(`   Cases: ${computerBenchmark.cases.join(', ')}`)
} else {
  console.log('❌ Benchmark 配置不存在')
}

if (computerScoreboard) {
  console.log(`✅ Scoreboard 存在 (${computerScoreboard.evaluations?.length || 0} 条记录)`)
  if (computerScoreboard.evaluations?.length > 0) {
    const latest = computerScoreboard.evaluations[computerScoreboard.evaluations.length - 1]
    console.log(`   最新分数: ${latest.score} (版本 ${latest.agentVersion})`)
    console.log(`   时间: ${latest.time}`)
  }
} else {
  console.log('⬜ Scoreboard 不存在（尚未运行评测）')
}

console.log('')

// 检查工具集目录
console.log('=== 工具集目录状态 ===')
const toolsDir = join(CONFIG_DIR, 'default-tools')
if (existsSync(toolsDir)) {
  const entries = require('node:fs').readdirSync(toolsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const toolsMdPath = join(toolsDir, entry.name, 'TOOLS.md')
      const hasToolsMd = existsSync(toolsMdPath)
      const configPath = join(toolsDir, entry.name, 'system_config.json')
      let version = 'N/A'
      if (existsSync(configPath)) {
        try {
          const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
          version = cfg.version ?? 'N/A'
        } catch {}
      }
      console.log(`${hasToolsMd ? '✅' : '❌'} ${entry.name} (v${version})`)
    }
  }
} else {
  console.log('❌ default-tools 目录不存在')
}

console.log('\n📋 说明:')
console.log('   - 真实评测需要在 Electron 主进程中运行（因为依赖 safeStorage 解密渠道 key）')
console.log('   - 评测面板路径: Agent Settings > Evaluations tab')
console.log('   - 或启动应用后通过 IPC 调用 runEvalBaseline()')
