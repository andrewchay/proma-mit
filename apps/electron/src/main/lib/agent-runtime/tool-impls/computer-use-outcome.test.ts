import { describe, expect, test } from 'bun:test'
import { classifyDesktopActionFailure, describeDesktopActionFailure } from './computer-use-outcome'

describe('classifyDesktopActionFailure', () => {
  test('Given 超时错误 When 分类 Then 结果未知', () => {
    const error = new Error('timed out')
    error.name = 'TimeoutError'
    expect(classifyDesktopActionFailure(error).outcome).toBe('unknown')
  })

  test('Given 中止错误 When 分类 Then 结果未知', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    expect(classifyDesktopActionFailure(error).outcome).toBe('unknown')
  })

  test('Given 网络类错误码 When 分类 Then 结果未知', () => {
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAGAIN']) {
      expect(classifyDesktopActionFailure(Object.assign(new Error('x'), { code })).outcome).toBe('unknown')
    }
  })

  test('Given 权限类错误码 When 分类 Then 未执行', () => {
    for (const code of ['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL']) {
      expect(classifyDesktopActionFailure(Object.assign(new Error('x'), { code })).outcome).toBe('not_applied')
    }
  })

  test('Given 中文前置失败文案 When 分类 Then 未执行', () => {
    expect(classifyDesktopActionFailure(new Error('未授权：需要屏幕录制权限')).outcome).toBe('not_applied')
    expect(classifyDesktopActionFailure(new Error('坐标越界')).outcome).toBe('not_applied')
    expect(classifyDesktopActionFailure(new Error('平台不支持')).outcome).toBe('not_applied')
  })

  test('Given 普通异常 When 分类 Then 保守判为结果未知', () => {
    expect(classifyDesktopActionFailure(new Error('CGEventPost failed')).outcome).toBe('unknown')
    expect(classifyDesktopActionFailure('字符串错误').outcome).toBe('unknown')
    expect(classifyDesktopActionFailure(undefined).outcome).toBe('unknown')
  })

  test('Given 超长错误信息 When 分类 Then 理由被截断', () => {
    const long = classifyDesktopActionFailure(new Error('x'.repeat(1000)))
    expect(long.reason.length).toBeLessThanOrEqual(300)
  })
})

describe('describeDesktopActionFailure', () => {
  test('Given 结果未知 When 生成文案 Then 禁止重试并要求先截图', () => {
    const failure = describeDesktopActionFailure('Click', new Error('socket hang up'))
    expect(failure.outcome).toBe('unknown')
    expect(failure.message).toContain('结果未知')
    expect(failure.message).toContain('禁止自动重试')
    expect(failure.message).toContain('ComputerUseScreenshot')
  })

  test('Given 未执行 When 生成文案 Then 说明可修正后重试', () => {
    const failure = describeDesktopActionFailure('Drag', Object.assign(new Error('denied'), { code: 'EACCES' }))
    expect(failure.outcome).toBe('not_applied')
    expect(failure.message).toContain('未执行')
    expect(failure.message).toContain('修正前置条件后可以重试')
    expect(failure.message).not.toContain('禁止自动重试')
  })
})
