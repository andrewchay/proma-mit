import { expect, test } from 'bun:test'
import {
	availableTaskEmployees,
	availableTaskWorkspaces,
} from './project-task-modes'

const employees = [
	{
		id: 'research',
		name: '需求分析师',
		enabled: true,
		executionProfile: 'controlled',
		workspaceIds: ['managed', 'local'],
	},
	{
		id: 'engineer',
		name: '研发',
		enabled: true,
		executionProfile: 'development',
		workspaceIds: ['local'],
	},
	{
		id: 'legacy',
		name: '旧普通员工',
		enabled: true,
		executionProfile: 'general',
	},
	{
		id: 'disabled',
		name: '停用员工',
		enabled: false,
		executionProfile: 'controlled',
	},
]
const workspaces = [
	{ id: 'managed', name: '托管' },
	{ id: 'local', name: '代码', rootPath: '/fixture/repository' },
	{ id: 'outside', name: '其他', rootPath: '/fixture/outside' },
]

test('Given 跨职能与研发员工 When 选择任务方式 Then 非代码和研发各自有独立入口，不混入旧全自动', () => {
	expect(
		availableTaskEmployees(employees, 'noncode').map((employee) => employee.id),
	).toEqual(['research'])
	expect(
		availableTaskEmployees(employees, 'ai').map((employee) => employee.id),
	).toEqual(['engineer'])
	expect(availableTaskEmployees(employees, 'normal')).toEqual([])
})

test('Given 真实员工/项目绑定 When 选择工作区 Then 托管可用但不能扩大到员工或项目范围外', () => {
	expect(
		availableTaskWorkspaces(employees[0], workspaces, ['managed']),
	).toEqual([workspaces[0]!])
	expect(
		availableTaskWorkspaces(employees[0], workspaces, ['managed', 'local']),
	).toEqual(workspaces.slice(0, 2))
	expect(
		availableTaskWorkspaces(employees[1], workspaces, ['managed', 'local']),
	).toEqual([workspaces[1]!])
	expect(availableTaskWorkspaces(employees[0], workspaces, [])).toEqual([])
	expect(availableTaskWorkspaces(undefined, workspaces, ['managed'])).toEqual(
		[],
	)
})
