/**
 * tab-atoms 测试 — 覆盖临时预览标签（VS Code 风格）语义
 */
import { describe, expect, test } from 'bun:test'
import {
  closeTab,
  openTab,
  openTabPermanent,
  openTabPreview,
  type TabItem,
} from './tab-atoms'

function agentTab(sessionId: string, title: string, preview?: boolean): TabItem {
  return { id: sessionId, type: 'agent', sessionId, title, preview }
}

describe('openTabPreview（单击 → 临时预览）', () => {
  test('无标签时新建临时预览标签', () => {
    const result = openTabPreview([], { type: 'agent', sessionId: 'A', title: '会话 A' })
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]?.preview).toBe(true)
    expect(result.activeTabId).toBe('A')
  })

  test('已存在临时预览标签时原地替换', () => {
    const tabs = [agentTab('A', '会话 A', true)]
    const result = openTabPreview(tabs, { type: 'agent', sessionId: 'B', title: '会话 B' })
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]?.id).toBe('B')
    expect(result.tabs[0]?.preview).toBe(true)
    expect(result.activeTabId).toBe('B')
  })

  test('已存在同会话标签时聚焦且保持临时属性', () => {
    const tabs = [agentTab('A', '会话 A', true), agentTab('B', '会话 B')]
    const result = openTabPreview(tabs, { type: 'agent', sessionId: 'A', title: '会话 A' })
    expect(result.tabs).toHaveLength(2)
    expect(result.tabs[0]?.preview).toBe(true)
    expect(result.activeTabId).toBe('A')
  })

  test('已存在同会话常驻标签时聚焦且不降级为临时', () => {
    const tabs = [agentTab('A', '会话 A')]
    const result = openTabPreview(tabs, { type: 'agent', sessionId: 'A', title: '会话 A' })
    expect(result.tabs[0]?.preview).toBeFalsy()
    expect(result.activeTabId).toBe('A')
  })
})

describe('openTabPermanent（双击 → 常驻）', () => {
  test('无标签时新建常驻标签', () => {
    const result = openTabPermanent([], { type: 'agent', sessionId: 'A', title: '会话 A' })
    expect(result.tabs[0]?.preview).toBeFalsy()
    expect(result.activeTabId).toBe('A')
  })

  test('将临时预览标签提升为常驻', () => {
    const tabs = [agentTab('A', '会话 A', true)]
    const result = openTabPermanent(tabs, { type: 'agent', sessionId: 'A', title: '会话 A' })
    expect(result.tabs[0]?.preview).toBeFalsy()
    expect(result.activeTabId).toBe('A')
  })

  test('常驻标签保持不变', () => {
    const tabs = [agentTab('A', '会话 A')]
    const result = openTabPermanent(tabs, { type: 'agent', sessionId: 'A', title: '会话 A' })
    expect(result.tabs).toBe(tabs)
    expect(result.activeTabId).toBe('A')
  })
})

describe('openTab（显式打开）', () => {
  test('显式打开临时预览标签时提升为常驻', () => {
    const tabs = [agentTab('A', '会话 A', true)]
    const result = openTab(tabs, { type: 'agent', sessionId: 'A', title: '会话 A' })
    expect(result.tabs[0]?.preview).toBeFalsy()
    expect(result.activeTabId).toBe('A')
  })
})

describe('closeTab', () => {
  test('关闭临时预览标签', () => {
    const tabs = [agentTab('A', '会话 A', true), agentTab('B', '会话 B')]
    const result = closeTab(tabs, 'A', 'A')
    expect(result.tabs.map((t) => t.id)).toEqual(['B'])
    expect(result.activeTabId).toBe('B')
  })
})
