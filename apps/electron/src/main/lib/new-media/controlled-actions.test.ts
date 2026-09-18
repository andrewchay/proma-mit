import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeNewMediaDb, putNewMediaRecord } from './new-media-sqlite-store'
import { approveControlledAction, getControlledActionAudit, requestControlledAction, resetControlledActionsForTests, simulateControlledAction } from './controlled-actions'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-new-media-actions-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await resetControlledActionsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

describe('新媒体受控外发', () => {
  test('未批准的外发请求不能模拟执行', async () => {
    const action = await requestControlledAction({ kind: 'publish', platform: 'xiaohongshu', targetId: 'draft-1', summary: '新品内容发布' })
    expect(action.status).toBe('pending_approval')
    await expect(simulateControlledAction(action.id)).rejects.toThrow('尚未批准')
  })

  test('批准主体由主进程固定，批准后只生成本地模拟回执，并且重启后重复执行幂等', async () => {
    const action = await requestControlledAction({ kind: 'send-reply', platform: 'wechat-official-account', targetId: 'reply-1', summary: '回复用户咨询' })
    const approved = await approveControlledAction(action.id)
    expect(approved.approvedBy).toBe('local-user')
    expect(approved.approvalPayloadHash).toHaveLength(64)
    const simulated = await simulateControlledAction(action.id)
    closeNewMediaDb()
    const retried = await simulateControlledAction(action.id)
    expect(simulated.status).toBe('simulated')
    expect(simulated.simulationReceipt).toStartWith('simulation:wechat-official-account:')
    expect(retried).toEqual(simulated)
  })

  test('审批后载荷变化会使原审批失效', async () => {
    const action = await requestControlledAction({ kind: 'publish', platform: 'xiaohongshu', targetId: 'draft-change', summary: '原始正文' })
    const approved = await approveControlledAction(action.id)
    await putNewMediaRecord('controlled-action', { ...approved, summary: '被修改的正文', revision: 2 })
    await expect(simulateControlledAction(action.id)).rejects.toThrow('原审批失效')
  })

  test('审计记录申请、审批和模拟回执', async () => {
    const action = await requestControlledAction({ kind: 'publish', platform: 'xiaohongshu', targetId: 'draft-2', summary: '品牌内容发布' })
    await approveControlledAction(action.id)
    await simulateControlledAction(action.id)
    const audit = await getControlledActionAudit(action.id)
    expect(audit.map((entry) => entry.event)).toEqual(['requested', 'approved', 'simulated'])
    expect(audit.at(-1)?.detail).toContain('未发生真实外部发布')
  })
})
