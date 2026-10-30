import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-project-changes-'))
const root = join(temp, 'root')
mkdirSync(root)
mock.module('./config-paths', () => ({ getProjectsDir: () => join(temp, 'data') }))
const { readProjectFileChanges, scanProjectFileChanges } = await import('./project-file-changes')
afterAll(() => rmSync(temp, { recursive: true, force: true }))

test('Given 项目已有基线 When 离线增删改文件后重新扫描 Then 记录变化并忽略构建缓存', async () => {
  expect(await readProjectFileChanges('workspace', root)).toBeNull()
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
  expect((await readProjectFileChanges('workspace', root))!.map(event => event.kind).sort()).toEqual(['added', 'deleted', 'modified'])
})

test('Given 项目目录不可用 When 扫描失败 Then 原基线仍可用于恢复后比较', async () => {
  const missing = `${root}-unavailable`
  renameSync(root, missing)
  try {
    await expect(scanProjectFileChanges('workspace', root)).rejects.toThrow()
  } finally {
    renameSync(missing, root)
  }
  expect(await scanProjectFileChanges('workspace', root)).toEqual([])
})
