import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-run-evidence-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const { ownerRunEvidenceSummary, buildOwnerRunEvidence } = await import('./project-owner-management-questions')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

test('Given 只有Token用量与未知费用 When 生成失败说明 Then 如实标未知且不声称已结清', () => {
  const text = ownerRunEvidenceSummary({ usage: { inputTokens: 3536, outputTokens: 482 }, cost: { source: 'unknown', usd: null }, stopped: false })
  expect(text).toContain('输入 3536 / 输出 482 tokens')
  expect(text).toContain('尚未取得可信成本')
  expect(text).toContain('没有自动重试')
  expect(text).not.toContain('已结清')
})

test('Given 服务商报告费用 When 生成失败说明 Then 标明来源且不当作账单确认', () => {
  const text = ownerRunEvidenceSummary({ usage: { inputTokens: 10, outputTokens: 20 }, cost: { source: 'runtime_reported', usd: 0.02 }, stopped: false })
  expect(text).toContain('0.02 美元（服务商报告）')
})

test('Given 无用量回执 When 生成失败说明 Then 不编造token数', () => {
  const text = ownerRunEvidenceSummary({ usage: null, cost: { source: 'unknown', usd: null }, stopped: false })
  expect(text).not.toContain('tokens')
  expect(text).toContain('尚未取得可信成本')
})

test('Given 已请求停止 When 生成失败说明 Then 说明停止仍需确认而不是宣称已停止', () => {
  const text = ownerRunEvidenceSummary({ usage: { inputTokens: 1, outputTokens: 1 }, cost: { source: 'unknown', usd: null }, stopped: true })
  expect(text).toContain('停止是否生效仍需原运行记录确认')
})

test('Given 回执只有用量与未知费用 When 生成结构化证据 Then 标注未知且不伪造账单', () => {
  expect(buildOwnerRunEvidence({ usage: { inputTokens: 3536, outputTokens: 482 }, cost: { source: 'unknown', usd: null }, stopped: false }))
    .toEqual({ inputTokens: 3536, outputTokens: 482, costSource: 'unknown', costUsd: null, stopped: false, autoRetried: false })
})

test('Given 服务商报告费用与停止请求 When 生成结构化证据 Then 保留来源并标记已请求停止', () => {
  expect(buildOwnerRunEvidence({ usage: { inputTokens: 10, outputTokens: 20 }, cost: { source: 'runtime_reported', usd: 0.02 }, stopped: true }))
    .toEqual({ inputTokens: 10, outputTokens: 20, costSource: 'runtime_reported', costUsd: 0.02, stopped: true, autoRetried: false })
})

test('Given 无用量回执 When 生成结构化证据 Then token 记为 null 而不是零', () => {
  expect(buildOwnerRunEvidence({ usage: null, cost: { source: 'unknown', usd: null }, stopped: false }))
    .toMatchObject({ inputTokens: null, outputTokens: null })
})
