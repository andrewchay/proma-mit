import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalCoordinator } from './goal-coordinator'
import { ElectronGoalStore } from './goal-store'

const previousConfig = process.env.PROMA_TEST_CONFIG_DIR
const directories: string[] = []
afterEach(() => {
  if (previousConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfig
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gravitas-goal-index-'))
  directories.push(directory); process.env.PROMA_TEST_CONFIG_DIR = directory
  return { directory, path: join(directory, 'goals.json'), store: new ElectronGoalStore() }
}

test('Given 索引损坏或格式无效 When 读取、创建或删除 Then 保留原文件并拒绝操作', () => {
  for (const contents of ['{broken', '{"version":1,"goals":[{}]}', '{"version":1,"goals":[{"id":"same","sessionId":"s"},{"id":"same","sessionId":"s"}]}']) {
    const { path, store } = fixture()
    writeFileSync(path, contents)
    expect(() => store.list()).toThrow('保留原文件')
    expect(() => new GoalCoordinator(store).create({ sessionId: 's', runtime: 'ai-sdk', objective: '测试' })).toThrow('保留原文件')
    expect(() => store.delete('same')).toThrow('保留原文件')
    expect(readFileSync(path, 'utf8')).toBe(contents)
  }
})

test('Given 首次启动或不可读索引路径 When 访问 Then 仅真正缺失文件视为空索引', () => {
  const first = fixture()
  expect(first.store.list()).toEqual([])
  const broken = fixture()
  symlinkSync(join(broken.directory, 'missing'), broken.path)
  expect(() => broken.store.list()).toThrow('保留原文件')
  const linked = fixture()
  writeFileSync(join(linked.directory, 'valid.json'), '{"version":1,"goals":[]}')
  symlinkSync(join(linked.directory, 'valid.json'), linked.path)
  expect(() => linked.store.list()).toThrow('保留原文件')
  const directory = fixture()
  mkdirSync(directory.path)
  expect(() => directory.store.list()).toThrow('保留原文件')
})


test('Given 固定临时文件名被链接到其他文件 When 创建 Goal Then 不覆盖链接目标', () => {
  const { directory, path, store } = fixture()
  const target = join(directory, 'untouched')
  writeFileSync(target, 'original')
  symlinkSync(target, path + '.tmp')
  const goal = new GoalCoordinator(store).create({ sessionId: 's', runtime: 'ai-sdk', objective: '测试' })
  expect(goal.objective).toBe('测试')
  expect(readFileSync(target, 'utf8')).toBe('original')
  expect(() => store.save({ ...goal, id: '../outside' })).toThrow('Goal ID 无效')
  expect(store.list().map(item => item.id)).toEqual([goal.id])
})
