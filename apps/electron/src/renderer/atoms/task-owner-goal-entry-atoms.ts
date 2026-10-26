import { atom } from 'jotai'

export interface TaskOwnerGoalSubject {
  projectId: string
  taskId: string
}

/** 同一窗口仅打开一个真实任务的目标草案，不触发读取、保存或执行。 */
export const taskOwnerGoalSubjectAtom = atom<TaskOwnerGoalSubject | null>(null)
