import { describe, expect, test } from 'bun:test'

/**
 * 外部工具规则测试（M6）：
 * - 描述符自洽（CLI 必须声明 binary；描述符型不得声明 binary）
 * - 状态判定优先级：未启用 → 许可未确认 → 未安装 → 版本不符 → 可用
 * - 启用需同时确认许可与填写版本（防止「装了但复现不了」）
 */

const {
  ResearchError,
  assertToolUsable,
  parseVersion,
  resolveToolStatus,
  validateToolDescriptor,
  validateToolEnableRequest,
} = await import('@gravitas/core/services/academic')

const CLI_DESCRIPTOR = {
  id: 'openresearch',
  name: 'OpenResearch (orx)',
  role: 'cli-adapter' as const,
  binary: 'orx',
  versionArgs: ['--version'],
  licenseNote: '上游许可待核（见仓库 LICENSE）',
  homepage: 'https://github.com/alphaXiv/OpenResearch',
  capabilities: ['实验树', '运行记录'],
  prerequisites: ['用户自行安装 orx CLI'],
}

const DESCRIPTOR_ONLY = {
  id: 'rd-agent',
  name: 'RD-Agent',
  role: 'descriptor-only' as const,
  licenseNote: 'MIT',
  homepage: 'https://github.com/microsoft/RD-Agent',
  capabilities: ['研发自动化'],
  prerequisites: ['需要 Python 环境与用户自行安装'],
}

describe('描述符校验', () => {
  test('CLI adapter 必须有 binary，且不接受路径', () => {
    expect(() => validateToolDescriptor(CLI_DESCRIPTOR)).not.toThrow()
    expect(() => validateToolDescriptor({ ...CLI_DESCRIPTOR, binary: undefined })).toThrow('必须声明可执行文件名')
    expect(() => validateToolDescriptor({ ...CLI_DESCRIPTOR, binary: '/usr/local/bin/orx' })).toThrow('只能是 PATH 中的可执行名')
  })

  test('描述符型不得声明 binary（避免被当作可执行能力）', () => {
    expect(() => validateToolDescriptor(DESCRIPTOR_ONLY)).not.toThrow()
    expect(() => validateToolDescriptor({ ...DESCRIPTOR_ONLY, binary: 'rdagent' })).toThrow('不应声明可执行文件')
  })

  test('缺许可说明或来源链接拒绝', () => {
    expect(() => validateToolDescriptor({ ...CLI_DESCRIPTOR, licenseNote: '' })).toThrow('许可说明与来源链接')
    expect(() => validateToolDescriptor({ ...CLI_DESCRIPTOR, homepage: ' ' })).toThrow('许可说明与来源链接')
  })
})

describe('状态判定优先级', () => {
  const base = { descriptor: CLI_DESCRIPTOR, config: { toolId: 'openresearch', enabled: true, licenseAcknowledgedAt: '2026-09-17T00:00:00.000Z', pinnedVersion: '0.4.2' } }

  test('未启用优先于一切', () => {
    const r = resolveToolStatus({ ...base, config: { ...base.config, enabled: false }, probe: { installed: true, version: '0.4.2' } })
    expect(r.status).toBe('disabled')
  })

  test('已安装但未确认许可 → license-not-acknowledged', () => {
    const r = resolveToolStatus({
      ...base,
      config: { toolId: 'openresearch', enabled: true },
      probe: { installed: true, version: '0.4.2' },
    })
    expect(r.status).toBe('license-not-acknowledged')
  })

  test('未安装 / 版本不符 / 可用', () => {
    expect(resolveToolStatus({ ...base, probe: { installed: false } }).status).toBe('not-installed')
    expect(
      resolveToolStatus({
        ...base,
        descriptor: { ...CLI_DESCRIPTOR, expectedVersionPrefix: '1.' },
        probe: { installed: true, version: '0.4.2' },
      }).status,
    ).toBe('version-mismatch')
    expect(resolveToolStatus({ ...base, probe: { installed: true, version: '0.4.2' } }).status).toBe('available')
  })

  test('描述符型即使安装也保持 disabled（不提供执行路径）', () => {
    const r = resolveToolStatus({
      descriptor: DESCRIPTOR_ONLY,
      config: { toolId: 'rd-agent', enabled: true, licenseAcknowledgedAt: '2026-09-17T00:00:00.000Z' },
      probe: { installed: true, version: '1.0.0' },
    })
    expect(r.status).toBe('disabled')
    expect(r.detail).toContain('仅登记描述符')
  })

  test('探测报错归一化为 probe-error', () => {
    expect(resolveToolStatus({ ...base, probe: { installed: false, error: 'EACCES' } }).status).toBe('probe-error')
  })
})

describe('启用门禁与可用性断言', () => {
  test('启用必须确认许可；CLI 还必须填版本', () => {
    expect(() =>
      validateToolEnableRequest({ enabled: true, descriptor: CLI_DESCRIPTOR }),
    ).toThrow('必须确认许可条款')

    expect(() =>
      validateToolEnableRequest({
        enabled: true,
        licenseAcknowledgedAt: '2026-09-17T00:00:00.000Z',
        descriptor: CLI_DESCRIPTOR,
      }),
    ).toThrow('需要填写实际安装版本')

    expect(() =>
      validateToolEnableRequest({
        enabled: true,
        licenseAcknowledgedAt: '2026-09-17T00:00:00.000Z',
        pinnedVersion: '0.4.2',
        descriptor: CLI_DESCRIPTOR,
      }),
    ).not.toThrow()

    // 描述符型不需要版本（不执行）
    expect(() =>
      validateToolEnableRequest({
        enabled: true,
        licenseAcknowledgedAt: '2026-09-17T00:00:00.000Z',
        descriptor: DESCRIPTOR_ONLY,
      }),
    ).not.toThrow()
  })

  test('不可用时断言给出可读原因', () => {
    expect(() =>
      assertToolUsable({ descriptor: CLI_DESCRIPTOR, status: 'not-installed', detail: '未检测到 orx' }),
    ).toThrow('未检测到 orx')
  })

  test('版本解析', () => {
    expect(parseVersion('orx 0.4.2')).toBe('0.4.2')
    expect(parseVersion('DVC version 3.50.1')).toBe('3.50.1')
    expect(parseVersion('no version here')).toBeUndefined()
  })

  test('错误类型为领域错误', () => {
    try {
      validateToolDescriptor({ ...CLI_DESCRIPTOR, id: '' })
    } catch (err) {
      expect(err).toBeInstanceOf(ResearchError)
    }
  })
})
