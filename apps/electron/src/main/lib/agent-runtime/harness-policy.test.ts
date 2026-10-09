import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const dir = mkdtempSync(join(tmpdir(), 'gravitas-harness-policy-'))
process.env.PROMA_TEST_CONFIG_DIR = dir
mock.module('electron', () => buildElectronMock())
const { DEFAULT_HARNESS_POLICY, HarnessPolicyError } = await import('@gravitas/shared')
const { loadHarnessPolicy, assertRuntimePolicy } = await import('./harness-policy')

afterAll(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(dir, { recursive: true, force: true })
})

const pathOf = (name: string) => join(dir, name)

describe('Harness 策略加载（P01/P04 配置侧）', () => {
  test('文件缺失 → 默认策略；合法文件 → 解析值', () => {
    const policy = loadHarnessPolicy(pathOf('missing.json'))
    expect(policy).toEqual(DEFAULT_HARNESS_POLICY)
    writeFileSync(pathOf('ok.json'), JSON.stringify({ policyVersion: 1, revision: 5, guarantees: { budgetStop: 'required', toolScheduling: 'required', planWriteScope: 'required' } }))
    expect(loadHarnessPolicy(pathOf('ok.json')).revision).toBe(5)
  })
  test('损坏 JSON / 未知字段 → 抛错且保留原件不覆写', () => {
    writeFileSync(pathOf('broken.json'), '{ not json')
    expect(() => loadHarnessPolicy(pathOf('broken.json'))).toThrow(HarnessPolicyError)
    expect(readFileSync(pathOf('broken.json'), 'utf8')).toBe('{ not json')
    writeFileSync(pathOf('unknown.json'), JSON.stringify({ policyVersion: 1, revision: 1, futureField: true, guarantees: { budgetStop: 'off', toolScheduling: 'off', planWriteScope: 'off' } }))
    expect(() => loadHarnessPolicy(pathOf('unknown.json'))).toThrow(/未知字段/)
    expect(readFileSync(pathOf('unknown.json'), 'utf8')).toContain('futureField')
  })
  test('assertRuntimePolicy：默认策略 ai-sdk 通过；required budgetStop 在 proma 拒绝', () => {
    expect(() => assertRuntimePolicy('ai-sdk', pathOf('missing.json'))).not.toThrow()
    expect(() => assertRuntimePolicy('proma', pathOf('ok.json'))).toThrow(/费用超额停止/)
    expect(() => assertRuntimePolicy('claude', pathOf('ok.json'))).toThrow(/工具调度串行化/)
  })
})
