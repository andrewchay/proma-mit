/**
 * 运行/调度索引读取保护测试：
 * 文件损坏时必须只读展示、拒绝写入，绝不用空索引覆盖原文件。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProactiveSchedulerStore } from './proactive-scheduler-store'
import { getProactiveRunsPath, getProactiveSchedulesPath } from './config-paths'

const previous = process.env.PROMA_TEST_CONFIG_DIR
const root = mkdtempSync(join(tmpdir(), 'gravitas-scheduler-store-'))
process.env.PROMA_TEST_CONFIG_DIR = join(root, 'config')

beforeAll(() => {
  rmSync(process.env.PROMA_TEST_CONFIG_DIR!, { recursive: true, force: true })
})

afterAll(() => {
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

describe('Proactive 索引读取保护', () => {
  test('运行索引损坏时：读取降级、写入拒绝、原文件不被覆盖', () => {
    const store = new ProactiveSchedulerStore()
    store.saveRun({ id: 'run-1', sourceType: 'manual', sourceId: 's-1', status: 'success', trigger: 'manual', startedAt: 1 })

    const path = getProactiveRunsPath()
    const original = readFileSync(path, 'utf-8')
    writeFileSync(path, '{broken json')

    const broken = new ProactiveSchedulerStore()
    // 读取降级为空列表，并标记损坏状态；绝不能因此变成可写状态
    expect(broken.listRuns()).toEqual([])
    expect(broken.getRunsReadError()).toBeTruthy()
    expect(() => broken.saveRun({ id: 'run-2', sourceType: 'manual', sourceId: 's-1', status: 'success', trigger: 'manual', startedAt: 2 }))
      .toThrow(/拒绝写入/)

    // 原文件内容必须保持损坏前的状态，不被空索引覆盖
    expect(readFileSync(path, 'utf-8')).toBe('{broken json')
    expect(JSON.parse(original).runs).toHaveLength(1)

    // 修复文件后可恢复写入
    writeFileSync(path, original)
    const recovered = new ProactiveSchedulerStore()
    expect(recovered.getRunsReadError()).toBeNull()
    recovered.saveRun({ id: 'run-2', sourceType: 'manual', sourceId: 's-1', status: 'success', trigger: 'manual', startedAt: 2 })
    expect(recovered.listRuns()).toHaveLength(2)
  })

  test('调度索引损坏时同样拒绝写入', () => {
    const store = new ProactiveSchedulerStore()
    store.saveSchedule({
      id: 'sch-1', title: '任务', channelId: 'ch', modelId: 'm', runtime: 'proma', prompt: 'p',
      schedule: { type: 'interval', intervalMs: 60_000 }, permissionMode: 'safe', enabled: true,
      consecutiveFailures: 0, createdAt: 1, updatedAt: 1,
    })
    writeFileSync(getProactiveSchedulesPath(), 'not-json')

    const broken = new ProactiveSchedulerStore()
    expect(broken.listSchedules()).toEqual([])
    expect(broken.getSchedulesReadError()).toBeTruthy()
    expect(() => broken.saveSchedule({
      id: 'sch-2', title: '任务2', channelId: 'ch', modelId: 'm', runtime: 'proma', prompt: 'p',
      schedule: { type: 'interval', intervalMs: 60_000 }, permissionMode: 'safe', enabled: true,
      consecutiveFailures: 0, createdAt: 1, updatedAt: 1,
    })).toThrow(/拒绝写入/)
  })
})
