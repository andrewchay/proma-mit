import { loadHarnessFlagOverrides, resolveHarnessFlagState } from './harness-flags'
import { setToolSchedulerDisabled } from './tool-scheduler-service'

/** 启动先保守串行，成功读取后才按配置恢复并行；损坏文件保留并向启动层报告。 */
export async function initializeHarnessFlags(configDir: string): Promise<void> {
  setToolSchedulerDisabled(true)
  const flags = resolveHarnessFlagState(await loadHarnessFlagOverrides(configDir))
  setToolSchedulerDisabled(!flags.toolScheduling)
}
