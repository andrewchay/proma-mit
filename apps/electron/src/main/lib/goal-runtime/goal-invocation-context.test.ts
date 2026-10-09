import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalCoordinator } from './goal-coordinator'
import { ElectronGoalStore } from './goal-store'

const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const dirs: string[] = []
afterEach(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture(configured = true) {
  const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-context-'))
  dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
  const store = new ElectronGoalStore()
  const c = new GoalCoordinator(store)
  const g = c.create({ sessionId: 's', runtime: 'ai-sdk', objective: '目标', ...(configured ? { workspaceId: 'w', channelId: 'ch', modelId: 'm' } : {}) })
  const run = c.captureRun('s')!
  const request = { runtime: 'ai-sdk' as const, workspaceId: 'w', channelId: 'ch', requestedModelId: 'm', provider: 'openai' as const, cwd: '/fixture' }
  return { c, store, g, run, request }
}
const complete = { outcome: 'complete' as const, summary: '完成', completed: [], evidence: [] }

describe('Goal已准备请求上下文，不代表Provider确认', () => {
  test('未准备不得提交检查点；不把缺失值猜成配置', async () => {
    const w = fixture()
    await expect(w.run.onCheckpoint(complete)).rejects.toThrow('未准备')
    expect(w.c.get(w.g.id)?.invocationContext).toBeUndefined()
  })
  for (const change of [
    { workspaceId: 'other' }, { workspaceId: undefined }, { channelId: 'other' },
    { runtime: 'pi' as const }, { requestedModelId: 'other' }, { requestedModelId: undefined },
  ]) {
    test(`不一致请求拒绝：${JSON.stringify(change)}`, async () => {
      const w = fixture()
      await expect(w.run.onPrepared({ ...w.request, ...change })).rejects.toThrow('不一致')
      expect(w.c.get(w.g.id)?.invocationContext).toBeUndefined()
      expect(w.c.get(w.g.id)?.activeRunId).toBe(w.run.runId)
    })
  }
  test('准备一次保存独立副本，不能第二次准备更换环境', async () => {
    const w = fixture()
    await w.run.onPrepared(w.request)
    w.request.cwd = '/changed'
    const context = w.c.get(w.g.id)?.invocationContext
    expect(context).toMatchObject({ version: 1, sourcePhase: 'prepared-request', goalId: w.g.id, sessionId: 's', runId: w.run.runId, cwd: '/fixture', requestedModelId: 'm' })
    expect(context?.preparedAt).toBeGreaterThan(0)
    await expect(w.run.onPrepared(w.request)).rejects.toThrow('已准备')
    await w.run.onCheckpoint(complete)
  })
  test('未配置workspace/model保持请求未知，不补造默认值；新run清旧投影', async () => {
    const w = fixture(false)
    await w.run.onPrepared({ ...w.request, workspaceId: undefined, requestedModelId: undefined })
    expect(w.c.get(w.g.id)?.invocationContext?.workspaceId).toBeUndefined()
    expect(w.c.get(w.g.id)?.invocationContext?.requestedModelId).toBeUndefined()
    w.c.captureRun('s')
    expect(w.c.get(w.g.id)?.invocationContext).toBeUndefined()
    await expect(w.run.onPrepared(w.request)).rejects.toThrow('已失效')
  })
  for (const change of [
    { workspaceId: 'other' }, { channelId: 'other' }, { modelId: 'other' },
    { runtime: 'pi' as const }, { objective: '新目标' }, { acceptanceCriteria: ['新条件'] },
  ]) {
    for (const beforePrepared of [true, false]) {
      test(`配置漂移在${beforePrepared ? '准备' : '检查点'}前拒绝：${JSON.stringify(change)}`, async () => {
        const w = fixture()
        if (!beforePrepared) await w.run.onPrepared(w.request)
        w.store.save({ ...w.c.get(w.g.id)!, ...change })
        await expect(beforePrepared ? w.run.onPrepared(w.request) : w.run.onCheckpoint(complete)).rejects.toThrow('配置已变化')
        expect(w.c.get(w.g.id)?.status).toBe('active')
      })
    }
  }
  test('无效请求不写记录；额外凭据和正文不进入投影', async () => {
    const w = fixture()
    await expect(w.run.onPrepared({ ...w.request, cwd: 'relative' })).rejects.toThrow('无效')
    await expect(w.run.onPrepared({ ...w.request, channelId: '' })).rejects.toThrow('无效')
    const input = { ...w.request, apiKey: 'fixture-not-secret', prompt: 'fixture正文', sourcePhase: 'provider-confirmed' }
    await w.run.onPrepared(input)
    const context = w.c.get(w.g.id)?.invocationContext
    expect(context).not.toHaveProperty('apiKey')
    expect(context).not.toHaveProperty('prompt')
    expect(context?.sourcePhase).toBe('prepared-request')
  })
  test('接受continue后配置变化，旧结束回调也不能自动续跑', async () => {
    const w = fixture()
    const requests: string[] = []
    w.c.setContinuationRunner(async ({ prompt }) => { requests.push(prompt); return true })
    await w.run.onPrepared(w.request)
    await w.run.onCheckpoint({ outcome: 'continue', summary: '继续', completed: [], evidence: [], nextAction: '下一步', wakeTrigger: { type: 'immediate' } })
    w.store.save({ ...w.c.get(w.g.id)!, objective: '新目标' })
    await w.run.onFinished(true)
    await Bun.sleep(0)
    expect(requests).toEqual([])
    expect(w.c.get(w.g.id)?.status).toBe('waiting')
    expect(w.c.get(w.g.id)?.checkpoint?.blocker).toContain('已变化')
  })

  test('记录上下文被替换时不接受检查点', async () => {
    const w = fixture()
    await w.run.onPrepared(w.request)
    const current = w.c.get(w.g.id)!
    w.store.save({ ...current, invocationContext: { ...current.invocationContext!, cwd: '/other' } })
    await expect(w.run.onCheckpoint(complete)).rejects.toThrow('上下文已变化')
  })
  test('暂停后的准备回调不能恢复Goal', async () => {
    const w = fixture()
    w.c.setStatus(w.g.id, 'waiting')
    await expect(w.run.onPrepared(w.request)).rejects.toThrow('已失效')
    expect(w.c.get(w.g.id)?.invocationContext).toBeUndefined()
  })
})
