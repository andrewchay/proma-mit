import { describe, expect, test } from 'bun:test'
import { createOpenResearchAdapter, mapOrxProject, mapOrxRun, normalizeOrxStatus, type ExecFn } from './openresearch-adapter'

/**
 * OpenResearch adapter 测试（M6.2）：
 * - 字段映射接受 camelCase 与 snake_case（上游序列化风格不确定）
 * - 未安装/输出非法给出可读错误，不伪造结果
 * - 状态归一化对未知状态保守处理（不猜测 completed）
 *
 * ⚠️ 这些是**离线契约测试**：字段名基于此前核实的上游表结构。
 * 真机联调（需安装 orx）未执行，不得据此声称已验收。
 */

function fakeExec(handlers: Record<string, string | Error>): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = []
  const exec: ExecFn = async (binary, args) => {
    calls.push([binary, ...args])
    const key = args[0] ?? ''
    const result = handlers[key]
    if (result === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    if (result instanceof Error) throw result
    return result
  }
  return { exec, calls }
}

describe('字段映射', () => {
  test('项目：接受 snake_case（上游 Rust 序列化）', () => {
    const project = mapOrxProject({
      id: 'p-1', name: '听力研究', slug: 'hearing',
      baseline_branch: 'main', run_command: 'python train.py', repo_path: '/repo',
    })
    expect(project?.id).toBe('p-1')
    expect(project?.baselineBranch).toBe('main')
    expect(project?.runCommand).toBe('python train.py')
  })

  test('项目：也接受 camelCase', () => {
    const project = mapOrxProject({ id: 'p-2', baselineBranch: 'dev', runCommand: 'Rscript x.R' })
    expect(project?.baselineBranch).toBe('dev')
  })

  test('缺 id 的记录被丢弃（不产生半条数据）', () => {
    expect(mapOrxProject({ name: 'no id' })).toBeNull()
    expect(mapOrxRun({ status: 'done' })).toBeNull()
  })

  test('运行：映射状态下拉与提交', () => {
    const run = mapOrxRun({
      id: 'r-1', project_id: 'p-1', status: 'done', exit_code: 0,
      created_at: 1789000000, commit_sha: 'abc123',
    })
    expect(run?.projectId).toBe('p-1')
    expect(run?.exitCode).toBe(0)
    expect(run?.commitSha).toBe('abc123')
  })
})

describe('adapter 调用', () => {
  test('listProjects 使用 --json 且解析数组', async () => {
    const { exec, calls } = fakeExec({
      projects: JSON.stringify([{ id: 'p-1', name: 'A' }, { id: 'p-2', name: 'B' }]),
    })
    const adapter = createOpenResearchAdapter(exec)
    const projects = await adapter.listProjects()
    expect(projects.map((p) => p.id)).toEqual(['p-1', 'p-2'])
    expect(calls[0]).toEqual(['orx', 'projects', '--json'])
  })

  test('listRuns 接受 {items: []} 包装形式', async () => {
    const { exec } = fakeExec({
      runs: JSON.stringify({ items: [{ id: 'r-1', experiment_id: 'e-1', status: 'done' }] }),
    })
    const adapter = createOpenResearchAdapter(exec)
    const runs = await adapter.listRuns('p-1')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.experimentId).toBe('e-1')
  })

  test('未安装 orx 时给出可读错误（不伪造空结果）', async () => {
    const { exec } = fakeExec({})
    const adapter = createOpenResearchAdapter(exec)
    await expect(adapter.listProjects()).rejects.toThrow('未检测到 orx CLI')
    await expect(adapter.listRuns('p-1')).rejects.toThrow('未检测到 orx CLI')
    await expect(adapter.readRunLog('r-1')).rejects.toThrow('未检测到 orx CLI')
  })

  test('输出非法 JSON 时说明可能上游改了格式', async () => {
    const { exec } = fakeExec({ projects: 'not json at all' })
    const adapter = createOpenResearchAdapter(exec)
    await expect(adapter.listProjects()).rejects.toThrow('不是合法 JSON')
  })

  test('probe 对已安装/未安装分别返回', async () => {
    const installed = createOpenResearchAdapter(fakeExec({ '--version': 'orx 0.4.2' }).exec)
    expect(await installed.probe()).toEqual({ installed: true, version: '0.4.2' })

    const missing = createOpenResearchAdapter(fakeExec({}).exec)
    expect((await missing.probe()).installed).toBe(false)
  })

  test('日志读取带 --bytes 限制', async () => {
    const { exec, calls } = fakeExec({ logs: 'log content' })
    const adapter = createOpenResearchAdapter(exec)
    const log = await adapter.readRunLog('r-1')
    expect(log).toBe('log content')
    expect(calls[0]).toEqual(['orx', 'logs', 'r-1', '--bytes', '262144'])
  })
})

describe('状态归一化（未知状态保守处理）', () => {
  test('已知状态映射', () => {
    expect(normalizeOrxStatus('done').status).toBe('completed')
    expect(normalizeOrxStatus('starting').status).toBe('running')
    expect(normalizeOrxStatus('cancelled').status).toBe('cancelled')
  })

  test('未知状态不猜测为 completed', () => {
    const unknown = normalizeOrxStatus('weird-new-state')
    expect(unknown.status).toBe('failed')
    expect(unknown.unmappedRaw).toBe('weird-new-state')

    // 有退出码时可依据退出码，但仍保留原始状态便于排查
    const withCode = normalizeOrxStatus('weird', 0)
    expect(withCode.status).toBe('completed')
    expect(withCode.unmappedRaw).toBe('weird')
  })
})
