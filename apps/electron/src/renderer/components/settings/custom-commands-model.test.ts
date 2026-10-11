import { describe, expect, test } from 'bun:test'
import { addCustomCommand, removeCustomCommand, replaceCustomCommand, validateCustomCommand } from './custom-commands-model'

const existing = [{ name: 'review', prompt: '审查当前改动的代码质量' }]

describe('自定义斜杠命令 —— 校验', () => {
  test('合法命令通过并规范化首尾空白', () => {
    const result = validateCustomCommand({ name: '  test  ', prompt: ' 跑测试 ' }, existing)
    expect(result).toEqual({ ok: true, command: { name: 'test', prompt: '跑测试' } })
  })

  test('空名 / 非法字符 / 超长被拒', () => {
    expect(validateCustomCommand({ name: '', prompt: 'x' }, existing).ok).toBe(false)
    expect(validateCustomCommand({ name: 'has space', prompt: 'x' }, existing).ok).toBe(false)
    expect(validateCustomCommand({ name: '中文', prompt: 'x' }, existing).ok).toBe(false)
    expect(validateCustomCommand({ name: 'a'.repeat(33), prompt: 'x' }, existing).ok).toBe(false)
  })

  test('空提示词被拒', () => {
    expect(validateCustomCommand({ name: 'ok', prompt: '   ' }, existing).ok).toBe(false)
  })

  test('重名被拒，编辑自身时放行', () => {
    expect(validateCustomCommand({ name: 'review', prompt: '新版本' }, existing).ok).toBe(false)
    expect(validateCustomCommand({ name: 'review', prompt: '新版本' }, existing, 'review')).toEqual({
      ok: true,
      command: { name: 'review', prompt: '新版本' },
    })
  })
})

describe('自定义斜杠命令 —— 列表操作', () => {
  test('新增追加到末尾', () => {
    expect(addCustomCommand(existing, { name: 'ship', prompt: '发布' })).toHaveLength(2)
  })

  test('替换命中项且不改长度，未命中时追加', () => {
    const replaced = replaceCustomCommand(existing, 'review', { name: 'review', prompt: 'v2' })
    expect(replaced).toEqual([{ name: 'review', prompt: 'v2' }])
    expect(replaceCustomCommand(existing, 'missing', { name: 'new', prompt: 'n' })).toHaveLength(2)
  })

  test('删除按名过滤', () => {
    expect(removeCustomCommand([...existing, { name: 'x', prompt: 'y' }], 'review')).toEqual([{ name: 'x', prompt: 'y' }])
  })
})
