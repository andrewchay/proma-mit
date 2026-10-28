import { loadHarnessFlagOverrides, resolveHarnessFlagState } from './harness-flags'
import { setToolSchedulerDisabled } from './tool-scheduler-service'
import type { HarnessSchedulerState } from '@gravitas/shared'

let schedulerState: HarnessSchedulerState = { status: 'loading', parallel: false }

export function getHarnessSchedulerState(): HarnessSchedulerState { return { ...schedulerState } }

/** 启动先保守串行，成功读取后才按配置恢复并行；损坏文件保留并向启动层报告。 */
export async function initializeHarnessFlags(configDir: string): Promise<void> {
  setToolSchedulerDisabled(true)
  schedulerState = { status: 'loading', parallel: false }
  try {
    const overrides = await loadHarnessFlagOverrides(configDir)
    const flags = resolveHarnessFlagState(overrides)
    setToolSchedulerDisabled(!flags.toolScheduling)
    schedulerState = { status: overrides?.toolScheduling === undefined ? 'default' : 'configured', parallel: flags.toolScheduling }
  } catch (error) {
    schedulerState = { status: 'invalid', parallel: false, error: error instanceof Error ? error.message : String(error) }
    throw error
  }
}
