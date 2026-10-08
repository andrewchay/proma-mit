/** 工作方式只筛选真实员工；岗位模板名不是负责人身份。 */
export type ProjectTaskMode = 'normal' | 'ai' | 'noncode'
export interface ProjectTaskEmployee {
	id: string
	name: string
	enabled: boolean
	executionProfile?: string
	workspaceIds?: string[]
	workspaceId?: string
}
interface TaskWorkspace {
	id: string
	rootPath?: string
}
export function availableTaskEmployees<T extends ProjectTaskEmployee>(
	employees: T[],
	mode: ProjectTaskMode,
): T[] {
	if (mode === 'normal') return []
	const profile = mode === 'ai' ? 'development' : 'controlled'
	return employees.filter(
		(employee) => employee.enabled && employee.executionProfile === profile,
	)
}
export function availableTaskWorkspaces<T extends TaskWorkspace>(
	employee: ProjectTaskEmployee | undefined,
	workspaces: T[],
	projectWorkspaceIds: string[],
): T[] {
	const ids =
		employee?.workspaceIds ??
		(employee?.workspaceId ? [employee.workspaceId] : [])
	return workspaces.filter(
		(workspace) =>
			ids.includes(workspace.id) &&
			projectWorkspaceIds.includes(workspace.id) &&
			(employee?.executionProfile !== 'development' ||
				Boolean(workspace.rootPath)),
	)
}
