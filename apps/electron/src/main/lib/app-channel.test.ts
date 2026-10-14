import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allowsAppUpdates, allowsAutomaticSideEffects, getAppIdentity, getAppServicePorts, resolveAppChannel } from './app-channel'

describe('开发版与正式版渠道隔离', () => {
  test('应用导入时不恢复 Goal、Proactive 或 Monitor 自动任务', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-service.ts'), 'utf8')
    expect(source).toContain('if (APP_AUTOMATIC_SIDE_EFFECTS)')
    expect(source).toContain('if (!APP_AUTOMATIC_SIDE_EFFECTS) return')
    expect(source).toContain('goalCoordinator.recoverDueGoals()')
    expect(source).toContain('proactiveScheduler.recover()')
    expect(source).toContain('startAllMonitors()')
  })
  test('源码运行始终为 Dev，旧正式安装包兼容 Stable', () => {
    expect(resolveAppChannel(false, 'stable')).toBe('dev')
    expect(resolveAppChannel(true)).toBe('stable')
    expect(resolveAppChannel(true, 'dev')).toBe('dev')
    expect(resolveAppChannel(true, 'stable')).toBe('stable')
    expect(() => resolveAppChannel(true, 'preview')).toThrow('未知应用渠道')
  })
  test('配置、userData、协议、安装身份不重叠', () => {
    const dev = getAppIdentity('dev')
    const stable = getAppIdentity('stable')
    for (const key of ['displayName', 'appId', 'configDirName', 'userDataDirName', 'deepLinkProtocol'] as const) {
      expect(dev[key]).not.toBe(stable[key])
    }
    expect(stable.configDirName).toBe('.gravitas')
    expect(stable.appId).toBe('com.gravitas.app')
  })
  test('Dev 默认无后台自动动作，也不读取正式更新', () => {
    expect(allowsAutomaticSideEffects('dev')).toBe(false)
    expect(allowsAutomaticSideEffects('stable')).toBe(true)
    expect(allowsAppUpdates('dev', true)).toBe(false)
    expect(allowsAppUpdates('stable', false)).toBe(false)
    expect(allowsAppUpdates('stable', true)).toBe(true)
  })
  test('Dev 本地服务使用临时端口，Stable 保持配置端口', () => {
    expect(getAppServicePorts('dev', { brief: 8765, companion: 8790 })).toEqual({ brief: 0, companion: 0 })
    expect(getAppServicePorts('stable', { brief: 8765, companion: 8790 })).toEqual({ brief: 8765, companion: 8790 })
  })
})
