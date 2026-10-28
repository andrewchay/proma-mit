import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindCoreToolEffects } from './tool-effects'
import { createReadToolDefinition, executeReadTool } from './tool-impls/read-tool'
import { getHarnessSchedulerState, initializeHarnessFlags } from './harness-startup'
import { runGuardedToolCall, setToolSchedulerDisabled } from './tool-scheduler-service'
import { saveHarnessFlagOverrides } from './harness-flags'

const dir = mkdtempSync(join(tmpdir(), 'gravitas-harness-startup-'))
const read = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
afterAll(() => { setToolSchedulerDisabled(false); rmSync(dir, { recursive: true, force: true }) })

async function maximumConcurrentReads(): Promise<number> {
  let active = 0
  let maximum = 0
  const call = () => runGuardedToolCall({ tool: read, args: { file_path: 'file.txt' }, ctx: { cwd: dir, sessionId: 'flags-test' }, execute: async () => {
    active++
    maximum = Math.max(maximum, active)
    await Bun.sleep(30)
    active--
    return { content: 'ok' }
  } })
  await Promise.all([call(), call()])
  return maximum
}

test('Given 持久化调度开关 When 启动或配置损坏 Then 应用配置并在错误时保持串行', async () => {
  writeFileSync(join(dir, 'file.txt'), '测试')
  await initializeHarnessFlags(dir)
  expect(getHarnessSchedulerState()).toMatchObject({ status: 'default', parallel: true })
  expect(await maximumConcurrentReads()).toBe(2)
  await saveHarnessFlagOverrides(dir, { toolScheduling: false })
  await initializeHarnessFlags(dir)
  expect(getHarnessSchedulerState()).toMatchObject({ status: 'configured', parallel: false })
  expect(await maximumConcurrentReads()).toBe(1)
  await saveHarnessFlagOverrides(dir, { toolScheduling: true })
  await initializeHarnessFlags(dir)
  expect(await maximumConcurrentReads()).toBe(2)
  writeFileSync(join(dir, 'harness-flags.json'), '{ invalid')
  await expect(initializeHarnessFlags(dir)).rejects.toThrow('原件已保留')
  expect(getHarnessSchedulerState()).toMatchObject({ status: 'invalid', parallel: false })
  expect(await maximumConcurrentReads()).toBe(1)
})
