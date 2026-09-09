import { describe, expect, test } from 'bun:test'
import {
  relocateExpandedPath,
  restoreExpandedFileTreeState,
  serializeFileTreeState,
  updateExpandedPath,
  pruneFileTreeState,
  type FileTreeExpandedState,
} from './file-tree-state'

describe('文件树视图状态', () => {
  test('展开状态按会话和文件根隔离', () => {
    const initial: FileTreeExpandedState = new Map()
    const updated = updateExpandedPath(initial, 'session-a:workspace', '/repo/src', true)

    expect(updated.get('session-a:workspace')?.get('/repo/src')).toBe(true)
    expect(updated.get('session-b:workspace')).toBeUndefined()
    expect(initial.size).toBe(0)
  })

  test('目录重命名时迁移自身和后代，不影响同名前缀兄弟目录', () => {
    let state: FileTreeExpandedState = new Map()
    state = updateExpandedPath(state, 'session-a:workspace', '/repo/src', true)
    state = updateExpandedPath(state, 'session-a:workspace', '/repo/src/lib', true)
    state = updateExpandedPath(state, 'session-a:workspace', '/repo/src-old', true)

    const moved = relocateExpandedPath(state, 'session-a:workspace', '/repo/src', '/repo/app')

    expect(moved.get('session-a:workspace')?.get('/repo/app')).toBe(true)
    expect(moved.get('session-a:workspace')?.get('/repo/app/lib')).toBe(true)
    expect(moved.get('session-a:workspace')?.get('/repo/src')).toBeUndefined()
    expect(moved.get('session-a:workspace')?.get('/repo/src-old')).toBe(true)
  })

  test('清理关闭会话状态时保留 standalone 文件树', () => {
    const state = new Map<string, Map<string, boolean>>([
      ['session-a\u0002workspace', new Map([['/a', true]])],
      ['session-b\u0002workspace', new Map([['/b', true]])],
      ['standalone\u0002/tmp', new Map([['/tmp/a', true]])],
    ])

    const pruned = pruneFileTreeState(state, new Set(['session-b']))

    expect([...pruned.keys()]).toEqual(['session-b\u0002workspace', 'standalone\u0002/tmp'])
  })
  test('序列化时只保存展开节点，并可从 settings.json 形态恢复', () => {
    const persisted = serializeFileTreeState(new Map([
      ['/workspace/src', true],
      ['/workspace/dist', false],
    ]), 128)

    expect(persisted).toEqual({ expandedPaths: ['/workspace/src'], scrollTop: 128 })
    expect([...restoreExpandedFileTreeState(persisted.expandedPaths)]).toEqual([
      ['/workspace/src', true],
    ])
  })
})
