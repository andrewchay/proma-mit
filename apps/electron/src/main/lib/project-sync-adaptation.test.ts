/**
 * 外部同步组语义适配测试 — Project Sync Adaptation Test
 *
 * 覆盖：
 * - 拉方向（外部→本地）：外部"未完成"不覆盖本地 started 组状态（钉钉把 in_progress 打回 pending 的 bug 回归）
 * - 拉方向：本地已完成组 + 外部"未完成" → 回退到默认未完成状态
 * - 拉方向：外部"完成" → 推进到本地完成状态
 * - 回声抑制数据基础：external-sync 来源的更新在 onTaskChange 上下文中可识别
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import {
  closeProjectDb,
  createProject,
  createTask,
  getTask,
  initProjectDb,
  updateTask as storeUpdateTask,
} from './project-sqlite-store'
import { pollExternalTaskStatus, type ExternalTaskStatusProvider } from './project-polling-service'
import { updateTask, onTaskChange, type TaskChangedFields } from './project-service'

const testDir = join(tmpdir(), `gravitas-sync-adapt-test-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  await initProjectDb()
})

afterAll(() => {
  closeProjectDb()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

/** 构造固定返回指定外部状态的 Provider */
function staticProvider(status: string | null): ExternalTaskStatusProvider {
  return {
    name: 'dingtalk',
    async queryStatus() {
      return status
    },
  }
}

/** 建一个已同步到钉钉的任务（externalSync 镜像状态可指定，模拟"上次同步时的外部状态"） */
async function seedSyncedTask(localStatus: string, mirrorStatus = localStatus): Promise<string> {
  const project = createProject({ title: `同步项目-${Date.now()}-${Math.random()}`, description: '' })
  const task = createTask(project.id, { title: '已同步任务', description: '' })
  storeUpdateTask(task.id, {
    status: localStatus as typeof task.status,
    externalSync: { dingtalk: { taskId: 'ext-1', status: mirrorStatus, syncedAt: Date.now(), unionId: 'un-1' } },
  })
  return task.id
}

describe('拉方向组语义映射（外部→本地）', () => {
  test('Given 本地 in_progress 且镜像为已完成 When 外部变回未完成 Then 本地状态保持 in_progress 不被打回', async () => {
    const taskId = await seedSyncedTask('in_progress', 'completed')
    const result = await pollExternalTaskStatus(taskId, 'dingtalk', staticProvider('pending'))
    const after = getTask(taskId)

    expect(result.changed).toBe(true)
    // 外部平台无法表达中间态：本地进行中状态必须原样保留
    expect(after?.status).toBe('in_progress')
    // 外部镜像状态已更新
    expect(after?.externalSync?.dingtalk?.status).toBe('pending')
  })

  test('Given 本地 paused 且镜像为已完成 When 外部恢复未完成 Then 本地状态保持 paused', async () => {
    const taskId = await seedSyncedTask('paused', 'completed')
    await pollExternalTaskStatus(taskId, 'dingtalk', staticProvider('pending'))
    expect(getTask(taskId)?.status).toBe('paused')
  })

  test('Given 本地已完成 When 外部恢复未完成 Then 回退到默认未完成状态(pending)', async () => {
    const taskId = await seedSyncedTask('completed', 'completed')
    const result = await pollExternalTaskStatus(taskId, 'dingtalk', staticProvider('pending'))
    const after = getTask(taskId)

    expect(result.changed).toBe(true)
    expect(after?.status).toBe('pending')
    expect(after?.completedAt).toBeUndefined()
  })

  test('Given 本地待处理 When 外部完成 Then 推进到 completed 并记录 completedAt', async () => {
    const taskId = await seedSyncedTask('pending', 'pending')
    const result = await pollExternalTaskStatus(taskId, 'dingtalk', staticProvider('completed'))
    const after = getTask(taskId)

    expect(result.changed).toBe(true)
    expect(after?.status).toBe('completed')
    expect(after?.completedAt).toBeDefined()
  })

  test('Given 本地已完成 When 外部仍完成 Then 无变化', async () => {
    const taskId = await seedSyncedTask('completed', 'completed')
    const result = await pollExternalTaskStatus(taskId, 'dingtalk', staticProvider('completed'))
    expect(result.changed).toBe(false)
  })
})

describe('回声抑制数据基础', () => {
  test('Given external-sync 来源更新 When 触发变更回调 Then 上下文可识别来源', async () => {
    const project = createProject({ title: `回声项目-${Date.now()}`, description: '' })
    const task = createTask(project.id, { title: '回声任务', description: '' })

    const seen: Array<{ source?: string; changedFields?: TaskChangedFields }> = []
    const unsubscribe = onTaskChange((_, action, context) => {
      if (action === 'updated') seen.push({ source: context?.source, changedFields: context?.changedFields })
    })
    try {
      await updateTask(task.id, {
        externalSync: { dingtalk: { taskId: 'x', status: 'completed', syncedAt: Date.now() } },
      }, { source: 'external-sync' })
    } finally {
      unsubscribe()
    }

    expect(seen.length).toBe(1)
    expect(seen[0]!.source).toBe('external-sync')
    // 仅 externalSync 平台键变化 → 同步层据此静默（不打外部 API）
    expect(Object.keys(seen[0]!.changedFields ?? {})).toEqual(['externalSync.dingtalk'])
  })

  test('Given 用户编辑标题 When 触发变更回调 Then 来源为 user 且 changedFields 含 title', async () => {
    const project = createProject({ title: `用户编辑项目-${Date.now()}`, description: '' })
    const task = createTask(project.id, { title: '原标题', description: '' })

    const seen: Array<{ source?: string; changedFields?: TaskChangedFields }> = []
    const unsubscribe = onTaskChange((_, action, context) => {
      if (action === 'updated') seen.push({ source: context?.source, changedFields: context?.changedFields })
    })
    try {
      await updateTask(task.id, { title: '新标题' })
    } finally {
      unsubscribe()
    }

    expect(seen.length).toBe(1)
    expect(seen[0]!.source).toBe('user')
    expect(seen[0]!.changedFields?.title).toBe(true)
  })
})
