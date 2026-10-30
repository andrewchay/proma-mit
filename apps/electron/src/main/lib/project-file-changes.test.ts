import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-project-changes-'))
const root = join(temp, 'root')
mkdirSync(root)
mock.module('./config-paths', () => ({ getProjectsDir: () => join(temp, 'data') }))
const { readProjectFileChanges, scanProjectFileChanges } = await import('./project-file-changes')
afterAll(() => rmSync(temp, { recursive: true, force: true }))

test('Given 项目已有基线 When 离线增删改文件后重新扫描 Then 记录变化并忽略构建缓存', async () => {
  expect(await readProjectFileChanges('workspace', root)).toMatchObject({ changes: [], lastScannedAt: null, scanError: null })
  writeFileSync(join(root, 'edit.txt'), 'before')
  writeFileSync(join(root, 'delete.txt'), 'remove')
  expect(await scanProjectFileChanges('workspace', root)).toEqual([])
  writeFileSync(join(root, 'edit.txt'), 'after change')
  rmSync(join(root, 'delete.txt'))
  writeFileSync(join(root, 'new.txt'), 'new')
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'ignored'), 'ignored')
  const changes = await scanProjectFileChanges('workspace', root)
  expect(changes.map(({ path, kind }) => [path, kind]).sort()).toEqual([
    ['delete.txt', 'deleted'], ['edit.txt', 'modified'], ['new.txt', 'added'],
  ])
  expect(await scanProjectFileChanges('workspace', root)).toEqual([])
  expect((await readProjectFileChanges('workspace', root)).changes.map(event => event.kind).sort()).toEqual(['added', 'deleted', 'modified'])
})

test('Given 项目目录不可用 When 扫描失败 Then 原基线仍可用于恢复后比较', async () => {
  const missing = `${root}-unavailable`
  renameSync(root, missing)
  try {
    await expect(scanProjectFileChanges('workspace', root)).rejects.toThrow()
    expect((await readProjectFileChanges('workspace', root)).scanError).toBeTruthy()
  } finally {
    renameSync(missing, root)
  }
  expect(await scanProjectFileChanges('workspace', root)).toEqual([])
  expect((await readProjectFileChanges('workspace', root)).scanError).toBeNull()
})

test('Given 用户调整忽略范围 When 重新扫描 Then 更新基线而非将忽略文件误报为删除', async () => {
  mkdirSync(join(root, 'private'))
  writeFileSync(join(root, 'private', 'note.txt'), 'private')
  await scanProjectFileChanges('ignore-case', root)
  writeFileSync(join(root, '.gravitasignore'), '# 本地文件\nprivate/\n')
  expect(await scanProjectFileChanges('ignore-case', root)).toEqual([])
  writeFileSync(join(root, 'private', 'note.txt'), 'changed')
  expect(await scanProjectFileChanges('ignore-case', root)).toEqual([])
  writeFileSync(join(root, '.gravitasignore'), '../outside\n')
  await expect(scanProjectFileChanges('ignore-case', root)).rejects.toThrow('相对路径')
  writeFileSync(join(root, '.gravitasignore'), '# 本地文件\nprivate/\n')
  expect((await scanProjectFileChanges('ignore-case', root)).map(event => event.path)).toEqual(['.gravitasignore'])
})


test('Given 文件内容等长修改且修改时间被还原 When 扫描 Then 通过状态变更时间发现变化', async () => {
  const file = join(root, 'same-size.txt')
  writeFileSync(file, 'before')
  await scanProjectFileChanges('ctime-case', root)
  const original = statSync(file)
  await new Promise(resolve => setTimeout(resolve, 20))
  writeFileSync(file, 'after!')
  utimesSync(file, original.atime, original.mtime)
  const events = await scanProjectFileChanges('ctime-case', root)
  expect(events.some(event => event.path === 'same-size.txt' && event.kind === 'modified')).toBe(true)
})
