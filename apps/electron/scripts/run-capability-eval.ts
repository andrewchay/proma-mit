/**
 * M4-04 / M6-05 真实验证入口（需显式授权后运行）。
 *
 * 矩阵：
 * - M4-04 工具选择准确率：10 cases × 2 variants × 3 runs = 60 次（zhipu glm-5.3-flash）
 * - M6-05 路由延迟/质量：10 cases × 2 providers × 2 runs = 40 次（zhipu + deepseek）
 * 合计上限 100 次；GRAVITAS_CAP_EVAL_AUTHORIZED_CALLS 必须不小于计划矩阵，
 * 否则在发起任何模型调用前退出。
 *
 * 运行（apps/electron 目录）：
 *   GRAVITAS_CAP_EVAL_AUTHORIZED_CALLS=100 \
 *   GRAVITAS_CAP_EVAL_SCOREBOARD=/absolute/private/path/cap-eval-scoreboard.json \
 *   GRAVITAS_CAP_EVAL_ZHIPU_CHANNEL_ID=... GRAVITAS_CAP_EVAL_DEEPSEEK_CHANNEL_ID=... \
 *   bun run cap:eval
 */

import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CapabilityCatalog, ProviderType } from '@gravitas/shared'
import { getChannelById, decryptApiKey } from '../src/main/lib/channel-manager'
import { resolveAgentRuntimeBaseUrl } from '@gravitas/shared'
import { buildTccExperimentDelegate, type TccEvalChannel } from '../src/main/lib/agent-runtime/context/tcc-spawn-real-delegate'
import { runToolSelectionExperiment, summarizeToolSelection } from '../src/main/lib/agent-runtime/context/tool-selection-experiment'
import { runRoutingLatencyExperiment, summarizeRoutingQuality, type RoutingLatencyProvider } from '../src/main/lib/agent-runtime/context/routing-latency-experiment'
import { buildSelectionCatalog, TOOL_SELECTION_CASES } from '../src/main/lib/agent-runtime/context/tool-selection-fixture'

app.setName('Gravitas')

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少必要环境变量 ${name}`)
  return value
}

function resolveChannel(channelId: string, modelId: string): TccEvalChannel {
  const channel = getChannelById(channelId)
  if (!channel) throw new Error(`渠道不存在: ${channelId}`)
  return {
    channelId: channel.id,
    provider: channel.provider,
    apiKey: decryptApiKey(channelId),
    baseUrl: resolveAgentRuntimeBaseUrl(channel.provider, 'proma', channel.baseUrl),
    modelId,
  }
}

async function main(): Promise<void> {
  const authorizedCalls = Number(requireEnv('GRAVITAS_CAP_EVAL_AUTHORIZED_CALLS'))
  if (!Number.isFinite(authorizedCalls) || authorizedCalls <= 0) throw new Error('授权调用数必须是正整数')
  const scoreboardPath = requireEnv('GRAVITAS_CAP_EVAL_SCOREBOARD')
  if (scoreboardPath.includes('/typed-context-compiler/')) throw new Error('评测产物必须写入仓库之外的私有路径')

  const zhipu = resolveChannel(requireEnv('GRAVITAS_CAP_EVAL_ZHIPU_CHANNEL_ID'), 'glm-5.3-flash')
  const deepseek = resolveChannel(requireEnv('GRAVITAS_CAP_EVAL_DEEPSEEK_CHANNEL_ID'), 'deepseek-v4-flash')
  const catalog: CapabilityCatalog = buildSelectionCatalog()

  const plannedSelection = TOOL_SELECTION_CASES.length * 2 * 3
  const plannedRouting = TOOL_SELECTION_CASES.length * 2 * 2
  if (authorizedCalls < plannedSelection + plannedRouting) {
    throw new Error(`Authorized calls (${authorizedCalls}) are fewer than the planned matrix (${plannedSelection + plannedRouting})`)
  }

  const isolationDir = process.env.GRAVITAS_CAP_EVAL_ISOLATION ?? join(app.getPath('temp'), 'cap-eval-isolation')
  mkdirSync(dirname(scoreboardPath), { recursive: true })
  mkdirSync(isolationDir, { recursive: true })

  const zhipuDelegate = buildTccExperimentDelegate(zhipu, { workspaceDir: isolationDir })
  const deepseekDelegate = buildTccExperimentDelegate(deepseek, { workspaceDir: isolationDir })

  const writeThrough = (data: unknown): void => {
    writeFileSyncSafe(scoreboardPath, data)
  }

  console.log(`[cap-eval] M4-04 selection matrix: ${plannedSelection} calls`)
  const selectionRuns = await runToolSelectionExperiment({
    cases: TOOL_SELECTION_CASES,
    catalog,
    runsPerCase: 3,
    delegate: zhipuDelegate,
    onRun: (run) => writeThrough({ selectionRuns: [run] }),
  })
  const selectionGate = summarizeToolSelection(selectionRuns)

  const routingProviders: RoutingLatencyProvider[] = [
    {
      id: 'zhipu-glm',
      provider: zhipu.provider as ProviderType,
      modelId: zhipu.modelId,
      pricing: { currency: 'CNY', source: 'fixture（未接入真实价目表，仅用于相对比较）', inputPerMTokens: 2, outputPerMTokens: 8 },
    },
    {
      id: 'deepseek-flash',
      provider: deepseek.provider as ProviderType,
      modelId: deepseek.modelId,
      pricing: { currency: 'CNY', source: 'fixture（未接入真实价目表，仅用于相对比较）', inputPerMTokens: 2, outputPerMTokens: 8 },
    },
  ]
  console.log(`[cap-eval] M6-05 routing matrix: ${plannedRouting} calls`)
  const routingRuns = await runRoutingLatencyExperiment({
    cases: TOOL_SELECTION_CASES,
    providers: routingProviders,
    runsPerCase: 2,
    catalog,
    delegate: async ({ providerId, caseId, task, systemPrompt }) => {
      const delegate = providerId === 'zhipu-glm' ? zhipuDelegate : deepseekDelegate
      return delegate({ caseId: `${providerId}:${caseId}`, variant: 'summary_on_demand', task, systemPrompt })
    },
    // 限速：调用间隔 1.5s，避免触发渠道 QPS 限制（上一轮 40/40 失败的可疑原因）
    pacingMs: Number(process.env.GRAVITAS_CAP_EVAL_PACING_MS ?? '1500'),
    onRun: (run) => writeThrough({ routingRuns: [run] }),
  })
  const routingReport = summarizeRoutingQuality(routingRuns)

  const result = {
    generatedAt: new Date().toISOString(),
    authorizedCalls,
    plannedCalls: plannedSelection + plannedRouting,
    executedCalls: selectionRuns.length + routingRuns.length,
    m4_04: { gate: selectionGate, runs: selectionRuns },
    m6_05: { report: routingReport, runs: routingRuns },
  }
  writeThrough(result)
  writeFileSync(scoreboardPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}

function writeFileSyncSafe(path: string, data: unknown): void {
  // 增量写仅为诊断便利；最终报告以结束时的完整 JSON 为准。
  require('node:fs').appendFileSync(`${path}.log`, `${JSON.stringify(data)}\n`)
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
  })
