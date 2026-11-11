import { expect, test } from 'bun:test'
import { mergeTaskSnapshot } from './project-task-view-sync'

interface T { id: string; dueDate?: number; title?: string }

test('Given 任务刚设置截止日期 When 合并派生快照 Then 甘特图数据源拿到新日期', () => {
  const derived: T[] = [{ id: 'a', title: '任务A' }, { id: 'b', title: '任务B' }]
  const authoritative: T[] = [{ id: 'a', title: '任务A', dueDate: 1_700_000_000_000 }, { id: 'b', title: '任务B' }]
  const merged = mergeTaskSnapshot(derived, authoritative)
  expect(merged.find((task) => task.id === 'a')?.dueDate).toBe(1_700_000_000_000)
})

test('Given 派生快照含草稿任务 When 声明它是派生独有 Then 保留下来', () => {
  const derived: T[] = [{ id: 'a', title: '正式任务' }, { id: 'draft-1', title: '草稿' }]
  const authoritative: T[] = [{ id: 'a', title: '正式任务（已改名）' }]
  const merged = mergeTaskSnapshot(derived, authoritative, (task) => task.id.startsWith('draft-'))
  expect(merged.map((task) => task.id)).toEqual(['a', 'draft-1'])
  expect(merged[0]!.title).toBe('正式任务（已改名）')
})

test('Given 未声明派生独有 When 列表里没有该条目 Then 视为已删除，不残留', () => {
  const derived: T[] = [{ id: 'a' }, { id: 'gone-1' }]
  const authoritative: T[] = [{ id: 'a' }]
  expect(mergeTaskSnapshot(derived, authoritative).map((task) => task.id)).toEqual(['a'])
})

test('Given 派生快照尚未加载 When 合并 Then 直接采用权威结果', () => {
  const authoritative: T[] = [{ id: 'a' }]
  expect(mergeTaskSnapshot([], authoritative)).toEqual(authoritative)
})

test('Given 合并 When 检查引用 Then 不修改入参', () => {
  const derived: T[] = [{ id: 'a', title: '旧' }]
  const authoritative: T[] = [{ id: 'a', title: '新' }]
  mergeTaskSnapshot(derived, authoritative)
  expect(derived[0]!.title).toBe('旧')
  expect(authoritative[0]!.title).toBe('新')
})

test('Given 新建任务 When 合并 Then 新任务必须出现在派生快照里', () => {
  const derived: T[] = [{ id: 'a' }]
  const authoritative: T[] = [{ id: 'a' }, { id: 'new-1', title: '刚建的任务' }]
  const merged = mergeTaskSnapshot(derived, authoritative)
  expect(merged.map((task) => task.id)).toContain('new-1')
})

test('Given 删除任务 When 合并 Then 被删任务不能残留在派生快照里', () => {
  const derived: T[] = [{ id: 'a' }, { id: 'deleted-1' }]
  const authoritative: T[] = [{ id: 'a' }]
  const merged = mergeTaskSnapshot(derived, authoritative)
  expect(merged.map((task) => task.id)).not.toContain('deleted-1')
})

test('Given 派生快照独有的草稿 When 合并 Then 草稿仍保留（不能因为删除逻辑误伤）', () => {
  // 草稿不在列表权威结果里，但它是派生视图自己的内容，必须保留。
  const derived: T[] = [{ id: 'a' }, { id: 'draft-1' }]
  const authoritative: T[] = [{ id: 'a' }, { id: 'b' }]
  const keep = new Set(['draft-1'])
  const merged = mergeTaskSnapshot(derived, authoritative, (task) => keep.has(task.id))
  // 顺序以授权列表为准，派生独有条目追加在末尾。
  expect(merged.map((task) => task.id)).toEqual(['a', 'b', 'draft-1'])
})
