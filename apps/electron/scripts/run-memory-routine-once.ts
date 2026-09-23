/**
 * run-memory-routine-once — 用当前源码真实运行一次记忆 Routine（诊断/验收工具）
 *
 * 用法（apps/electron 目录下）：
 *   bun run build:memory-routine-runner   # esbuild 打包到 dist/
 *   ./node_modules/.bin/electron dist/run-memory-routine-once.cjs [routineInstanceId]
 *
 * 行为：
 * - 从绑定的 Schedule（routineInstanceId 匹配）读取执行目标（渠道/模型/工作区/权限）。
 * - 走与 app 相同的受控链路：validateProactiveTarget → Orchestrator → Routine 成果链
 *   （输入装配、输出契约、阶段追踪、审批幂等），结果写入真实 ~/.gravitas/ 运行记录。
 * - 真实调用模型，可能产生渠道费用；完成后进程自动退出。
 * - 不支持 Claude / Pi runtime（脚本内为占位实现，仅 proma / ai-sdk 真实可用）。
 */

import { app } from 'electron'
import { statSync } from 'node:fs'
import type { AgentProviderAdapter, AgentRuntime, ProactiveExecutionTarget } from '@gravitas/shared'
import { AgentEventBus } from '../src/main/lib/agent-event-bus'
import { createElectronRuntimeServices } from '../src/main/lib/agent-runtime/runtime-services'
import { ProviderAgnosticAgentAdapter } from '../src/main/lib/adapters/provider-agnostic-agent-adapter'
import { AISDKAgentAdapter } from '../src/main/lib/adapters/ai-sdk-agent-adapter'
import { RuntimeRoutingAgentAdapter } from '../src/main/lib/adapters/runtime-routing-agent-adapter'
import { AgentOrchestrator } from '../src/main/lib/agent-orchestrator'
import { runRoutineInstance, setRoutineRunner } from '../src/main/lib/routine-service'
import { validateProactiveTarget, extractCurrentProactiveOutput, getMessageIdentity, ProactiveExecutionError } from '../src/main/lib/proactive-target-validation'
import { createAgentSession, getAgentSessionMessages } from '../src/main/lib/agent-session-manager'
import { getChannelById } from '../src/main/lib/channel-manager'
import { getAgentWorkspace } from '../src/main/lib/agent-workspace-manager'
import { ProactiveSchedulerStore } from '../src/main/lib/proactive-scheduler-store'

/** 默认运行「每日记忆整理」实例 */
const DEFAULT_MEMORY_ROUTINE_ID = 'e6137eb4-ae70-4142-b0ed-62eb5ab871d0'

function unsupportedRuntime(name: string): AgentProviderAdapter {
  return {
    query: () => { throw new Error(`${name} runtime 不在本脚本支持范围，请使用 Gravitas / AI SDK 渠道`) },
    abort: () => {},
  } as unknown as AgentProviderAdapter
}

// ===== 与 agent-service 相同的 headless 受控执行入口（精简窗口路由版） =====

const eventBus = new AgentEventBus()
const runtimeServices = createElectronRuntimeServices(eventBus)
const adapter = new RuntimeRoutingAgentAdapter({
  claude: unsupportedRuntime('Claude'),
  proma: new ProviderAgnosticAgentAdapter(runtimeServices.mcp),
  pi: unsupportedRuntime('Pi'),
  'ai-sdk': new AISDKAgentAdapter(runtimeServices.mcp),
})
const orchestrator = new AgentOrchestrator(
  adapter,
  eventBus,
  runtimeServices,
  () => Promise.resolve(),
  () => false,
)

async function runTarget(
  title: string,
  target: Pick<ProactiveExecutionTarget, 'sessionId' | 'workspaceId' | 'channelId' | 'modelId' | 'runtime' | 'prompt' | 'newSession' | 'permissionMode'>,
): Promise<{ sessionId: string; outputSummary?: string; output?: string }> {
  let runError: string | undefined
  let output: string | undefined
  let outputSummary: string | undefined
  const checked = validateProactiveTarget(target, {
    getChannel: getChannelById,
    getSession: () => undefined,
    getWorkspace: getAgentWorkspace,
    isDirectory: (path) => { try { return statSync(path).isDirectory() } catch { return false } },
  })
  let targetSessionId = checked.sessionId
  if (checked.newSession) {
    const meta = createAgentSession(`主动任务：${title.slice(0, 30)}`, checked.channelId, checked.workspaceId, checked.modelId, checked.runtime)
    targetSessionId = meta.id
  }
  if (!targetSessionId) throw new Error('主动任务缺少目标会话')
  const previousIds = new Set(getAgentSessionMessages(targetSessionId).map(getMessageIdentity))
  await orchestrator.sendMessage({
    sessionId: targetSessionId,
    userMessage: checked.prompt,
    channelId: checked.channelId,
    modelId: checked.modelId,
    workspaceId: checked.workspaceId,
    agentRuntime: checked.runtime,
    permissionModeOverride: checked.permissionMode ?? 'safe',
  }, {
    onError: (error) => { runError = error },
    onComplete: (messages, result) => {
      if (result?.stoppedByUser) runError = '运行已由用户停止'
      output = extractCurrentProactiveOutput(messages ?? [], previousIds)
      outputSummary = output?.replace(/\s+/g, ' ').trim().slice(0, 500)
    },
    onTitleUpdated: () => {},
  })
  if (runError) throw new ProactiveExecutionError(runError, targetSessionId)
  if (!output) {
    output = extractCurrentProactiveOutput(getAgentSessionMessages(targetSessionId), previousIds)
    outputSummary = output?.replace(/\s+/g, ' ').trim().slice(0, 500)
  }
  if (!output) throw new ProactiveExecutionError('本次运行没有生成结果，请打开会话检查权限或模型响应', targetSessionId)
  return { sessionId: targetSessionId, outputSummary, output }
}

// ===== 主流程 =====

app.whenReady().then(async () => {
  const instanceId = process.argv[2] ?? DEFAULT_MEMORY_ROUTINE_ID
  try {
    const schedules = new ProactiveSchedulerStore().listSchedules()
    const bound = schedules.find((schedule) => schedule.routineInstanceId === instanceId)
    if (!bound) throw new Error(`未找到绑定到 Routine ${instanceId} 的调度，请先在 Proactive Center 创建`)
    console.log(`[run-memory-routine] 目标：渠道=${bound.channelId} 模型=${bound.modelId} runtime=${bound.runtime} 工作区=${bound.workspaceId ?? '（空）'} 权限=${bound.permissionMode}`)

    setRoutineRunner(async (_instance, target) => runTarget('Routine', target))
    const run = await runRoutineInstance(instanceId, {
      sessionId: bound.sessionId,
      workspaceId: bound.workspaceId,
      channelId: bound.channelId,
      modelId: bound.modelId,
      runtime: bound.runtime,
      prompt: bound.prompt,
      newSession: bound.newSession ?? true,
      permissionMode: bound.permissionMode,
    }, 'manual')

    console.log('[run-memory-routine] 运行结果:', JSON.stringify({
      id: run.id,
      status: run.status,
      error: run.error ?? null,
      memoryStage: run.memoryStage ?? null,
      memoryCandidates: run.memoryCandidates ?? null,
      sessionId: run.sessionId ?? null,
      outputSummary: run.outputSummary ?? null,
    }, null, 2))
    app.exit(run.status === 'success' ? 0 : 1)
  } catch (error) {
    console.error('[run-memory-routine] 执行失败:', error)
    app.exit(2)
  }
})
