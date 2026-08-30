import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approveApproval,
  createApproval,
  editApproval,
  getPendingApprovals,
  setApprovedChangeExecutor,
} from './approval-service'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = await mkdtemp(join(tmpdir(), 'gravitas-approval-service-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir

afterAll(async () => {
  setApprovedChangeExecutor(async () => {})
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(join(configDir, 'proactive'), { recursive: true, force: true })
})

describe('ApprovalService', () => {
  test('given an approved change when its executor succeeds then the decision and execution outcome are both persisted', async () => {
    let receivedApprovalId = ''
    setApprovedChangeExecutor(async (approval) => {
      receivedApprovalId = approval.id
    })
    const approval = createApproval({
      sourceType: 'memory',
      title: '写入偏好',
      summary: '保存用户偏好',
      proposedChange: { type: 'memory_write', title: '语言偏好', content: '中文' },
    })

    const resolved = await approveApproval(approval.id)

    expect(receivedApprovalId).toBe(approval.id)
    expect(resolved).toMatchObject({ status: 'approved', executionStatus: 'succeeded' })
    expect(resolved?.executedAt).toBeNumber()
  })

  test('given an approved change when its executor fails then the failure is retained rather than reported as applied', async () => {
    setApprovedChangeExecutor(async () => {
      throw new Error('目标工作区不可用')
    })
    const approval = createApproval({
      sourceType: 'file',
      title: '写入文件',
      summary: '保存报告',
      proposedChange: { type: 'file_write' },
    })

    const resolved = await approveApproval(approval.id)

    expect(resolved).toMatchObject({
      status: 'approved',
      executionStatus: 'failed',
      executionError: '目标工作区不可用',
    })
  })

  test('given an edited approval when listed for confirmation then it remains actionable until it is approved again', () => {
    const approval = createApproval({
      sourceType: 'memory',
      title: '写入偏好',
      summary: '保存用户偏好',
      proposedChange: { type: 'memory_write', title: '原始', content: '原始内容' },
    })

    editApproval(approval.id, { type: 'memory_write', title: '修订', content: '修订内容' })

    expect(getPendingApprovals()).toEqual([
      expect.objectContaining({ id: approval.id, status: 'edited' }),
    ])
  })
})
