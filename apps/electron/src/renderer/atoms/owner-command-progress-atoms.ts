import { atom } from 'jotai'
import type { OwnerExecutionAutonomousScheduleStatus, OwnerExecutionCommandView, ProjectOwnerExecutionCommandApi, ProjectOwnerGoalSubject } from '@gravitas/shared'

export interface OwnerCommandProgress {
  commands: OwnerExecutionCommandView[]
  schedule: OwnerExecutionAutonomousScheduleStatus | null
  loaded: boolean
  loading: boolean
  error: string
}
const empty: OwnerCommandProgress = { commands: [], schedule: null, loaded: false, loading: false, error: '' }
const key = (subject: ProjectOwnerGoalSubject) => JSON.stringify([subject.projectId, subject.taskId ?? null])
export const ownerCommandProgressAtom = atom(new Map<string, OwnerCommandProgress>())
export const getOwnerCommandProgress = (entries: ReadonlyMap<string, OwnerCommandProgress>, subject: ProjectOwnerGoalSubject) => entries.get(key(subject)) ?? empty
export const ownerCommandProgressApiAtom = atom<Pick<ProjectOwnerExecutionCommandApi, 'listOwnerExecutionCommands' | 'getOwnerAutonomousScheduleStatus'>>({
  listOwnerExecutionCommands: subject => window.electronAPI.paa.project.listOwnerExecutionCommands(subject),
  getOwnerAutonomousScheduleStatus: subject => window.electronAPI.paa.project.getOwnerAutonomousScheduleStatus(subject),
})
/** 只读刷新按主体隔离、并发去重；失败保留上次事实并明确标记尚未更新。 */
export const loadOwnerCommandProgressAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const read = () => getOwnerCommandProgress(get(ownerCommandProgressAtom), subject)
  const update = (patch: Partial<OwnerCommandProgress>) => {
    const entries = new Map(get(ownerCommandProgressAtom))
    entries.set(key(subject), { ...read(), ...patch })
    set(ownerCommandProgressAtom, entries)
  }
  if (read().loading) return
  update({ loading: true, error: '' })
  try {
    const api = get(ownerCommandProgressApiAtom)
    const [commands, schedule] = await Promise.all([api.listOwnerExecutionCommands(subject), api.getOwnerAutonomousScheduleStatus(subject)])
    if (!commands.ok) throw new Error(commands.error.message)
    if (!schedule.ok) throw new Error(schedule.error.message)
    // 正式调度API按项目返回；taskId过滤由命令列表承担，UI不将其他任务调度冒充本任务进度。
    if (schedule.value.projectId !== subject.projectId || subject.taskId && commands.value.some(command => command.taskId !== subject.taskId))
      throw new Error('运行进度响应主体不匹配')
    update({ commands: commands.value, schedule: schedule.value, loaded: true })
  } catch (cause) { update({ error: cause instanceof Error ? cause.message : '读取运行进度失败', loaded: false }) }
  finally { update({ loading: false }) }
})
