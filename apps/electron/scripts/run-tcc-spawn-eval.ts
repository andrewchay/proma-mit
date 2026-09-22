/**
 * Typed Context Compiler 真实评测入口（需显式授权后才运行）。
 *
 * 前置条件：
 *   - 用户已明确授权本次真实模型调用次数；
 *   - 离线 preflight 通过（协议同源、投影含必需项、不泄漏私密项、token 节省 ≥ 20%）。
 *
 * 运行方式（apps/electron 目录）：
 *   GRAVITAS_TCC_EVAL_AUTHORIZED_CALLS=90 \
 *   GRAVITAS_TCC_EVAL_SCOREBOARD=/absolute/private/path/tcc-m3-spawn-scoreboard.json \
 *   GRAVITAS_TCC_EVAL_CHANNEL_ID=<channel-id> \
 *   GRAVITAS_TCC_EVAL_MODEL_ID=glm-5.3-flash \
 *   bun run tcc:eval
 *
 * 安全边界：凭据只在主进程内解密；评测子任务 tools 为空、权限为 safe、cwd 为临时隔离目录；
 * 逐条 scoreboard 只写入显式指定的私有路径，不进入版本库。
 */

import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getChannelById, decryptApiKey } from '../src/main/lib/channel-manager'
import { resolveAgentRuntimeBaseUrl } from '@gravitas/shared'
import { runTccSpawnEvaluation } from '../src/main/lib/agent-runtime/context/tcc-spawn-eval-harness'

// safeStorage 解密前必须先固定应用名，否则密文无法解开。
app.setName('Gravitas')

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少必要环境变量 ${name}`)
  return value
}

async function main(): Promise<void> {
  const channelId = requireEnv('GRAVITAS_TCC_EVAL_CHANNEL_ID')
  const modelId = requireEnv('GRAVITAS_TCC_EVAL_MODEL_ID')
  const scoreboardPath = requireEnv('GRAVITAS_TCC_EVAL_SCOREBOARD')
  const authorizedCalls = Number(requireEnv('GRAVITAS_TCC_EVAL_AUTHORIZED_CALLS'))
  if (!Number.isFinite(authorizedCalls) || authorizedCalls <= 0) throw new Error('授权调用数必须是正整数')
  if (scoreboardPath.includes('/typed-context-compiler/')) {
    throw new Error('评测产物必须写入仓库之外的私有路径')
  }

  const channel = getChannelById(channelId)
  if (!channel) throw new Error(`渠道不存在: ${channelId}`)

  const isolationDir = process.env.GRAVITAS_TCC_EVAL_ISOLATION ?? join(app.getPath('temp'), 'tcc-eval-isolation')
  mkdirSync(dirname(scoreboardPath), { recursive: true })

  const report = await runTccSpawnEvaluation({
    fixturePath: join(__dirname, '../src/main/lib/agent-runtime/context/fixtures/m3-spawn-representative.json'),
    scoreboardPath,
    isolationDir,
    authorizedCalls,
    runsPerCase: 3,
    provider: channel.provider,
    modelId,
    implementationVersion: 'tcc-spawn-m3-v2',
  }, {
    channelId: channel.id,
    provider: channel.provider,
    apiKey: decryptApiKey(channelId),
    baseUrl: resolveAgentRuntimeBaseUrl(channel.provider, 'proma', channel.baseUrl),
    modelId,
  }, { workspaceDir: isolationDir, permissionMode: 'safe' })

  console.log(JSON.stringify({
    planned: report.planned,
    alreadyRecorded: report.alreadyRecorded,
    executed: report.executed,
    passed: report.gate.passed,
    reasons: report.gate.reasons,
    summaries: report.gate.summaries,
  }, null, 2))
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
  })
