import { expect, test } from 'bun:test'
import { hasSeparateRepositoryRoot } from './side-panel-file-roots'

test('Given 会话和仓库指向同一目录 When 展示文件面板 Then 只展示一棵树', () => {
  expect(hasSeparateRepositoryRoot('/project/', '/project')).toBe(false)
  expect(hasSeparateRepositoryRoot('C:\\project', 'C:/project/')).toBe(false)
})

test('Given 两个目录不同或会话目录尚未加载 When 展示文件面板 Then 保留仓库树', () => {
  expect(hasSeparateRepositoryRoot('/project/session', '/project')).toBe(true)
  expect(hasSeparateRepositoryRoot(null, '/project')).toBe(true)
  expect(hasSeparateRepositoryRoot('/project', null)).toBe(false)
})
