/** 场景验收使用真实临时 Git 仓库；runner 为确定性只读检查，不冒充真实 Provider 验收。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ProactiveScheduler } from './proactive-scheduler'
import { ProactiveSchedulerStore } from './proactive-scheduler-store'
import { validateProactiveTarget } from './proactive-target-validation'

const previous = process.env.PROMA_TEST_CONFIG_DIR
const root = mkdtempSync(join(tmpdir(), 'gravitas-project-loop-'))
process.env.PROMA_TEST_CONFIG_DIR = join(root, 'config')
const repo = join(root, 'repo')
mkdirSync(repo)
const git = (...args: string[]): string =>
	execFileSync('git', args, {
		cwd: repo,
		encoding: 'utf8',
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
	})
afterAll(() => {
	if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
	else process.env.PROMA_TEST_CONFIG_DIR = previous
	rmSync(root, { recursive: true, force: true })
})

test('指定项目检查：试跑、持久化、失败修复重试、暂停与启动补跑形成闭环', async () => {
	git('init', '-q')
	writeFileSync(join(repo, 'tracked.txt'), 'baseline\n')
	git('add', 'tracked.txt')
	git(
		'-c',
		'user.name=Test',
		'-c',
		'user.email=test@example.invalid',
		'-c',
		'commit.gpgsign=false',
		'commit',
		'-qm',
		'baseline',
	)
	writeFileSync(join(repo, 'tracked.txt'), 'modified\n')
	writeFileSync(join(repo, 'new.txt'), 'untracked\n')
	const before = git('status', '--porcelain')
	let now = Date.now()
	let enabled = true
	const facts = {
		getChannel: () => ({ enabled, models: [{ id: 'model', enabled: true }] }),
		getSession: () => undefined,
		getWorkspace: () => ({ rootPath: repo }),
		isDirectory: () => true,
	}
	const store = new ProactiveSchedulerStore()
	const scheduler = new ProactiveScheduler(store, () => now)
	scheduler.setRunner(async (target) => {
		validateProactiveTarget(target, facts)
		const output = `项目：${repo}\n检查时间：${new Date(now).toISOString()}\n${git('status', '--porcelain')}\n${git('diff', '--stat')}`
		return {
			sessionId: 'test-session',
			output,
			outputSummary: '只读检查发现 tracked.txt 和 new.txt',
		}
	})
	try {
		const target = validateProactiveTarget(
			{
				title: '项目未提交变更检查',
				workspaceId: 'workspace',
				channelId: 'channel',
				modelId: 'model',
				runtime: 'proma' as const,
				newSession: true,
				permissionMode: 'safe' as const,
				prompt: '只读检查当前项目',
				schedule: { type: 'interval' as const, intervalMs: 60_000 },
			},
			facts,
		)
		const schedule = scheduler.create(target)
		const first = await scheduler.runNow(schedule.id)
		expect(first.status).toBe('success')
		expect(first.output).toContain(' M tracked.txt')
		expect(first.output).toContain('?? new.txt')
		expect(
			new ProactiveSchedulerStore()
				.listRuns()
				.find((run) => run.id === first.id)?.output,
		).toBe(first.output)
		expect(git('status', '--porcelain')).toBe(before)
		enabled = false
		const failed = await scheduler.runNow(schedule.id)
		expect(failed.status).toBe('failed')
		expect(failed.error).toContain('渠道')
		enabled = true
		expect((await scheduler.runNow(schedule.id)).status).toBe('success')
		expect(store.listRuns().find((run) => run.id === failed.id)?.status).toBe(
			'failed',
		)
		scheduler.pause(schedule.id)
		now += 120_000
		await scheduler.recover()
		expect(store.listRuns()).toHaveLength(3)
		scheduler.resume(schedule.id)
		now += 120_000
		await scheduler.recover()
		expect(store.listRuns()).toHaveLength(4)
		expect(store.listRuns().at(-1)?.trigger).toBe('recovery')
		expect(git('status', '--porcelain')).toBe(before)
	} finally {
		scheduler.dispose()
	}
})
