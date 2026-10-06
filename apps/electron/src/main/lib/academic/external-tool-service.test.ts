import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 外部工具服务测试（M6）：
 * - 注册表描述符自洽；不内置上游产物（无二进制/源码）
 * - 探测用注入实现（离线）；安装/未安装/报错三态
 * - 启用需许可确认 + 版本固定；配置落盘不含凭据
 * - 配置损坏时保留原件拒绝读写
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'external-tool-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function load() {
  return import(`./external-tool-service?t=${Math.random()}`)
}

/** 注入式探测：按工具 id 返回预设结果 */
function fakeProbe(map: Record<string, { installed: boolean; version?: string; error?: string }>) {
  return async (descriptor: { id: string }) => map[descriptor.id] ?? { installed: false }
}

describe('注册表', () => {
  test('四个工具已登记，且描述符自洽', async () => {
    const svc = await load()
    const descriptors = svc.listToolDescriptors() as Array<{ id: string; licenseNote: string; homepage: string; capabilities: string[] }>
    expect(descriptors.map((d) => d.id).sort()).toEqual(['biomni', 'dvc', 'openresearch', 'rd-agent'])
    for (const d of descriptors) {
      expect(d.licenseNote.length).toBeGreaterThan(0)
      expect(d.homepage.startsWith('https://')).toBe(true)
      expect(d.capabilities.length).toBeGreaterThan(0)
    }
  })

  test('RD-Agent / Biomni 是描述符型（不提供执行路径）', async () => {
    const svc = await load()
    for (const id of ['rd-agent', 'biomni']) {
      const d = svc.getToolDescriptor(id)
      expect(d.role).toBe('descriptor-only')
      expect(d.binary).toBeUndefined()
    }
  })

  test('未知工具报错', async () => {
    const svc = await load()
    expect(() => svc.getToolDescriptor('nope')).toThrow('未知外部工具')
  })
})

describe('探测与状态', () => {
  test('未启用时为 disabled（不因已安装而自动启用）', async () => {
    const svc = await load()
    const view = await svc.probeTool('openresearch', fakeProbe({ openresearch: { installed: true, version: '0.4.2' } }))
    expect(view.status).toBe('disabled')
  })

  test('启用但未确认许可 → license-not-acknowledged', async () => {
    const svc = await load()
    svc.saveToolConfig({ toolId: 'openresearch', enabled: true })
    const view = await svc.probeTool('openresearch', fakeProbe({ openresearch: { installed: true, version: '0.4.2' } }))
    expect(view.status).toBe('license-not-acknowledged')
    expect(view.detail).toContain('许可')
  })

  test('启用 + 确认许可 + 已安装 → available 并给出检测版本', async () => {
    const svc = await load()
    svc.saveToolConfig({
      toolId: 'dvc', enabled: true,
      licenseAcknowledgedAt: '2026-09-17T00:00:00.000Z', pinnedVersion: '3.50.1',
    })
    const view = await svc.probeTool('dvc', fakeProbe({ dvc: { installed: true, version: '3.50.1' } }))
    expect(view.status).toBe('available')
    expect(view.detectedVersion).toBe('3.50.1')
  })

  test('未安装与探测报错可区分', async () => {
    const svc = await load()
    svc.saveToolConfig({ toolId: 'dvc', enabled: true, licenseAcknowledgedAt: '2026-09-17T00:00:00.000Z', pinnedVersion: '3.50.1' })

    const missing = await svc.probeTool('dvc', fakeProbe({ dvc: { installed: false } }))
    expect(missing.status).toBe('not-installed')
    expect(missing.detail).toContain('自行安装')

    const errored = await svc.probeTool('dvc', fakeProbe({ dvc: { installed: false, error: '探测失败: EACCES' } }))
    expect(errored.status).toBe('probe-error')
  })

  test('probeAllTools 覆盖全部登记工具', async () => {
    const svc = await load()
    const views = await svc.probeAllTools(fakeProbe({ openresearch: { installed: true, version: '1.0.0' } }))
    expect(views).toHaveLength(4)
  })
})

describe('配置落盘', () => {
  test('保存与读取；文件不含凭据字段', async () => {
    const svc = await load()
    svc.saveToolConfig({
      toolId: 'openresearch', enabled: true,
      licenseAcknowledgedAt: '2026-09-17T00:00:00.000Z', pinnedVersion: '0.4.2',
    })
    const config = svc.getToolConfig('openresearch')
    expect(config.enabled).toBe(true)
    expect(config.pinnedVersion).toBe('0.4.2')

    const raw = readFileSync(join(tempDir, 'academic', 'external-tools.json'), 'utf8')
    expect(raw).not.toContain('token')
    expect(raw).not.toContain('apiKey')
    expect(raw).not.toContain('secret')
  })

  test('未配置的工具返回默认 disabled', async () => {
    const svc = await load()
    expect(svc.getToolConfig('dvc')).toEqual({ toolId: 'dvc', enabled: false })
  })

  test('配置损坏时保留原件并拒绝读写', async () => {
    const svc = await load()
    const dir = join(tempDir, 'academic')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'external-tools.json'), '{broken', 'utf8')

    expect(() => svc.listToolConfigs()).toThrow('损坏')
    expect(readFileSync(join(dir, 'external-tools.json'), 'utf8')).toBe('{broken')
  })
})
