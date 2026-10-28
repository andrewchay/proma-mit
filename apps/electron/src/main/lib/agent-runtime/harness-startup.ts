import { loadHarnessFlagOverrides, resolveHarnessFlagState, saveHarnessFlagOverrides } from './harness-flags'
import { setToolSchedulerDisabled } from './tool-scheduler-service'
import type { HarnessSchedulerState } from '@gravitas/shared'

let schedulerState: HarnessSchedulerState = { status: 'loading', parallel: false }
let pendingSave: Promise<void> = Promise.resolve()

export function getHarnessSchedulerState(): HarnessSchedulerState { return { ...schedulerState } }

/** 仅为下次启动保存，先读取以避免覆盖损坏的原配置；同进程写入按序执行。 */
export function saveHarnessSchedulingForNextStartup(configDir: string, parallel: boolean): Promise<void> {
  const operation = pendingSave.then(async () => {
    if (typeof parallel !== 'boolean') throw new Error('调度设置必须为布尔值')
    await loadHarnessFlagOverrides(configDir)
    await saveHarnessFlagOverrides(configDir, { toolScheduling: parallel })
  })
  pendingSave = operation.catch(() => {})
  return operation
}

/** 启动先保守串行，成功读取后才按配置恢复并行；损坏文件保留并向启动层报告。 */
export async function initializeHarnessFlags(configDir: string | (() => string)): Promise<void> {
  setToolSchedulerDisabled(true)
  schedulerState = { status: 'loading', parallel: false }
  try {
    const overrides = await loadHarnessFlagOverrides(typeof configDir === 'function' ? configDir() : configDir)
    const flags = resolveHarnessFlagState(overrides)
    setToolSchedulerDisabled(!flags.toolScheduling)
    schedulerState = { status: overrides?.toolScheduling === undefined ? 'default' : 'configured', parallel: flags.toolScheduling }
  } catch (error) {
    schedulerState = { status: 'invalid', parallel: false, error: error instanceof Error ? error.message : String(error) }
    throw error
  }
}
