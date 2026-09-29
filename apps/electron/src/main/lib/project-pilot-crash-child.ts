import { initProjectDb, getProjectDb, getTask } from './project-sqlite-store'
import { resolvePilotApproval } from './project-pilot-approval'

// 仅由 G1 测试子进程执行，父进程在 READY 信号后 SIGKILL；不连接 Provider。
const [mode, projectId, taskId, versionText] = process.argv.slice(2)
if ((mode !== 'before' && mode !== 'after') || !projectId || !taskId || !versionText) throw new Error('G1 崩溃夹具参数无效')
const version = Number(versionText)
await initProjectDb()
if (mode === 'before') {
  getProjectDb().transaction(() => {
    const task = getTask(taskId)
    if (!task || task.updatedAt !== version || task.status !== 'paused') throw new Error('G1 审批来源已变化')
    getProjectDb().prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?")
      .run(version + 1, taskId)
    // 模拟审批状态已写入但尚未提交的窗口；测试父进程负责立即强制终止。
    process.stdout.write('READY_BEFORE\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
  })()
} else {
  await resolvePilotApproval(projectId, taskId, 'approved', { sourceVersion: version, note: '已确认继续' })
  process.stdout.write('READY_AFTER\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
}
