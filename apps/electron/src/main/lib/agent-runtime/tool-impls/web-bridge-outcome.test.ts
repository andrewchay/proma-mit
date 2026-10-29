import { describe, expect, test } from 'bun:test'
import {
  DOWNLOAD_CONFIRM_HINT,
  classifyWebBridgeActionFailure,
  describeWebBridgeActionFailure,
} from './web-bridge-outcome'

describe('classifyWebBridgeActionFailure', () => {
  test('Given 连接在动作后关闭 When 分类 Then 结果未知', () => {
    for (const message of [
      'Target closed',
      'Session closed',
      'WebSocket is not open',
      'socket hang up',
      'Protocol error (Input.dispatchMouseEvent)',
      'Node is detached from document',
    ]) {
      expect(classifyWebBridgeActionFailure(new Error(message)).outcome).toBe('unknown')
    }
  })

  test('Given 超时或中止 When 分类 Then 结果未知', () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    expect(classifyWebBridgeActionFailure(timeout).outcome).toBe('unknown')
    const aborted = new Error('aborted')
    aborted.name = 'AbortError'
    expect(classifyWebBridgeActionFailure(aborted).outcome).toBe('unknown')
  })

  test('Given 网络类错误码 When 分类 Then 结果未知', () => {
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN']) {
      expect(classifyWebBridgeActionFailure(Object.assign(new Error('x'), { code })).outcome).toBe('unknown')
    }
  })

  test('Given 尚未导航或目标不存在 When 分类 Then 未执行', () => {
    for (const message of [
      '尚未导航，请先调用 WebBridgeNavigate',
      'No node with given id 42',
      'No target with given id PAGE1',
      'element not found',
      'ref 已失效，请重新 Observe',
      'Invalid parameters: element_id',
    ]) {
      expect(classifyWebBridgeActionFailure(new Error(message)).outcome).toBe('not_applied')
    }
  })

  test('Given 权限拒绝 When 分类 Then 未执行', () => {
    expect(classifyWebBridgeActionFailure(Object.assign(new Error('denied'), { code: 'EACCES' })).outcome).toBe('not_applied')
    expect(classifyWebBridgeActionFailure(new Error('未授权：用户拒绝该操作')).outcome).toBe('not_applied')
  })

  test('Given DNS 解析失败 When 分类 Then 未执行', () => {
    expect(classifyWebBridgeActionFailure(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })).outcome).toBe(
      'not_applied',
    )
  })

  test('Given 无法归类的异常 When 分类 Then 保守判为结果未知', () => {
    expect(classifyWebBridgeActionFailure(new Error('CDP send failed')).outcome).toBe('unknown')
    expect(classifyWebBridgeActionFailure(undefined).outcome).toBe('unknown')
    expect(classifyWebBridgeActionFailure({ weird: true }).outcome).toBe('unknown')
  })

  test('Given 超长错误信息 When 分类 Then 理由被截断', () => {
    expect(classifyWebBridgeActionFailure(new Error('x'.repeat(2000))).reason.length).toBeLessThanOrEqual(300)
  })
})

describe('describeWebBridgeActionFailure', () => {
  test('Given 结果未知 When 生成文案 Then 禁止重试并要求重新观察页面', () => {
    const failure = describeWebBridgeActionFailure('Click', new Error('Target closed'))
    expect(failure.outcome).toBe('unknown')
    expect(failure.message).toContain('WebBridgeClick 结果未知')
    expect(failure.message).toContain('禁止自动重试')
    expect(failure.message).toContain('WebBridgeObserve')
    expect(failure.message).toContain('WebBridgeSnapshot')
  })

  test('Given 未执行 When 生成文案 Then 允许修正后重试', () => {
    const failure = describeWebBridgeActionFailure('Type', new Error('No node with given id 7'))
    expect(failure.outcome).toBe('not_applied')
    expect(failure.message).toContain('WebBridgeType 未执行')
    expect(failure.message).toContain('修正前置条件后可以重试')
    expect(failure.message).not.toContain('禁止自动重试')
  })

  test('Given 下载失败 When 生成文案 Then 指引核对落盘而不是页面状态', () => {
    const failure = describeWebBridgeActionFailure('Download', new Error('socket hang up'), DOWNLOAD_CONFIRM_HINT)
    expect(failure.outcome).toBe('unknown')
    expect(failure.message).toContain('下载目录')
    expect(failure.message).not.toContain('WebBridgeObserve')
  })
})
