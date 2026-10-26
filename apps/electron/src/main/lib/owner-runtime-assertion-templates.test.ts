import { describe, expect, test } from 'bun:test'
import { OWNER_RUNTIME_ASSERTION_TEMPLATES, selectOwnerRuntimeAssertionTemplates } from './owner-runtime-assertion-templates'

describe('内置运行验证断言模板', () => {
  test('Given 模板注册表 When 检查 Then 标识唯一且脚本可执行', () => {
    const ids = OWNER_RUNTIME_ASSERTION_TEMPLATES.map(template => template.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const template of OWNER_RUNTIME_ASSERTION_TEMPLATES) {
      expect(template.title.trim().length).toBeGreaterThan(0)
      expect(template.intentKeywords.length).toBeGreaterThan(0)
      // 脚本必须是可求值的表达式（此处只做语法构造检查，真实执行由受管浏览器负责）。
      expect(() => new Function(`return ${template.script}`)).not.toThrow()
    }
  })

  test('Given 合并计分意图 When 选择模板 Then 命中合并与计分断言', () => {
    const ids = selectOwnerRuntimeAssertionTemplates(['验证合并与计分']).map(template => template.id)
    expect(ids).toContain('behavior.merge')
    expect(ids).not.toContain('storage.best-score')
  })

  test('Given 多个意图 When 选择模板 Then 去重且保持注册顺序', () => {
    const ids = selectOwnerRuntimeAssertionTemplates(['页面可加载', '棋盘', '最大分数持久化']).map(template => template.id)
    expect(ids).toEqual([...new Set(ids)])
    expect(ids).toEqual(['html.loads', 'dom.board', 'storage.best-score'])
  })

  test('Given 意图为空 When 选择模板 Then 退回默认子集而非空集', () => {
    expect(selectOwnerRuntimeAssertionTemplates([]).map(template => template.id)).toEqual(['html.loads', 'dom.board', 'dom.initial-tiles'])
  })

  test('Given 意图无法识别 When 选择模板 Then 仍退回默认子集', () => {
    expect(selectOwnerRuntimeAssertionTemplates(['随便看看这个作品']).map(template => template.id)).toEqual(['html.loads', 'dom.board', 'dom.initial-tiles'])
  })

  test('Given 全部模板 When 检查脚本 Then 不发起网络请求也不写文件', () => {
    for (const template of OWNER_RUNTIME_ASSERTION_TEMPLATES) {
      expect(template.script).not.toMatch(/fetch\s*\(|XMLHttpRequest|WebSocket|node:fs|require\s*\(/)
    }
  })
})
