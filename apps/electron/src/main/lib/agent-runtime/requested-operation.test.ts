import { describe, expect, test } from 'bun:test'
import { resolveRequestedOperation } from './requested-operation'

describe('resolveRequestedOperation', () => {
  test('精确的 /compact 命令会分流为压缩操作', () => {
    expect(resolveRequestedOperation('/compact')).toBe('compact')
    expect(resolveRequestedOperation('  /compact\n')).toBe('compact')
  })

  test('普通文本和带参数的相似文本仍发送给模型', () => {
    expect(resolveRequestedOperation('/compact now')).toBeUndefined()
    expect(resolveRequestedOperation('请执行 /compact')).toBeUndefined()
    expect(resolveRequestedOperation('/COMPACT')).toBeUndefined()
  })
})
