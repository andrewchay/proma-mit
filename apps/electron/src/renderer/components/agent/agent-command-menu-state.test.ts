import { describe, expect, test } from 'bun:test'
import {
  filterCommandMenuItems,
  formatSessionReferenceDescription,
  getCommandMenuChildQuery,
  getNextCommandMenuIndex,
  shouldOpenSlashCommandMenu,
  shouldOpenSlashCommandMenuInContext,
} from './agent-command-menu-state'

describe('getNextCommandMenuIndex', () => {
  test('given empty list then returns 0', () => {
    expect(getNextCommandMenuIndex(0, 1, 0)).toBe(0)
  })

  test('given current at last when moving down then wraps to first', () => {
    expect(getNextCommandMenuIndex(2, 1, 3)).toBe(0)
  })

  test('given current at first when moving up then wraps to last', () => {
    expect(getNextCommandMenuIndex(0, -1, 3)).toBe(2)
  })
})

describe('filterCommandMenuItems', () => {
  const items = [
    { id: 'skill-a', label: '代码审查', description: 'review code' },
    { id: 'tool-b', label: '网络搜索', description: 'search web' },
    { id: 'session-c', label: '历史会话', description: 'session context' },
  ]

  test('given empty query then returns all items', () => {
    expect(filterCommandMenuItems(items, '')).toHaveLength(3)
    expect(filterCommandMenuItems(items, '   ')).toHaveLength(3)
  })

  test('given query matching id then filters correctly', () => {
    const result = filterCommandMenuItems(items, 'skill-a')
    expect(result.map((i) => i.id)).toEqual(['skill-a'])
  })

  test('given query matching label then filters correctly', () => {
    const result = filterCommandMenuItems(items, '搜索')
    expect(result.map((i) => i.id)).toEqual(['tool-b'])
  })

  test('given query matching description then filters case-insensitively', () => {
    const result = filterCommandMenuItems(items, 'SESSION')
    expect(result.map((i) => i.id)).toEqual(['session-c'])
  })

  test('given query matching nothing then returns empty', () => {
    expect(filterCommandMenuItems(items, 'zzz')).toHaveLength(0)
  })
})

describe('getCommandMenuChildQuery', () => {
  test('given query starts with page entry then slices prefix', () => {
    expect(getCommandMenuChildQuery('skill代码', 'skill')).toBe('代码')
  })

  test('given query without page entry then returns query unchanged', () => {
    expect(getCommandMenuChildQuery('代码', 'skill')).toBe('代码')
  })
})

describe('formatSessionReferenceDescription', () => {
  test('given workspace name and snippet then joins with separator', () => {
    expect(formatSessionReferenceDescription({ workspaceName: 'proma-mit', snippet: '修复权限' }))
      .toBe('工作区：proma-mit · 修复权限')
  })

  test('given same workspace name and slug then uses name only', () => {
    expect(formatSessionReferenceDescription({ workspaceName: 'proma-mit', workspaceSlug: 'proma-mit' }))
      .toBe('工作区：proma-mit')
  })

  test('given different slug then disambiguates with parentheses', () => {
    expect(formatSessionReferenceDescription({ workspaceName: '项目A', workspaceSlug: 'project-a' }))
      .toBe('工作区：项目A (project-a)')
  })

  test('given only snippet then returns snippet', () => {
    expect(formatSessionReferenceDescription({ snippet: 'hello' })).toBe('hello')
  })

  test('given nothing then returns undefined', () => {
    expect(formatSessionReferenceDescription({})).toBeUndefined()
  })
})

describe('shouldOpenSlashCommandMenu', () => {
  test('given plain slash token then opens', () => {
    expect(shouldOpenSlashCommandMenu('/')).toBe(true)
    expect(shouldOpenSlashCommandMenu('/skill')).toBe(true)
  })

  test('given token containing space then does not open', () => {
    expect(shouldOpenSlashCommandMenu('/skill name')).toBe(false)
  })

  test('given token with second slash then does not open', () => {
    expect(shouldOpenSlashCommandMenu('/foo/bar')).toBe(false)
  })
})

describe('shouldOpenSlashCommandMenuInContext', () => {
  test('given path prefix C:/ then does not open', () => {
    expect(shouldOpenSlashCommandMenuInContext('C:', '/Users')).toBe(false)
  })

  test('given url prefix https: then does not open', () => {
    expect(shouldOpenSlashCommandMenuInContext('https:', '/docs')).toBe(false)
  })

  test('given relative path foo/ then does not open', () => {
    expect(shouldOpenSlashCommandMenuInContext('foo', '/bar')).toBe(false)
  })

  test('given plain slash at start then opens', () => {
    expect(shouldOpenSlashCommandMenuInContext('', '/')).toBe(true)
  })

  test('given chinese text before slash then opens without spaces', () => {
    expect(shouldOpenSlashCommandMenuInContext('继续调用', '/skill')).toBe(true)
  })
})
