import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectOwnerPlanDraft } from '@gravitas/shared'
import { appendProjectOwnerPlanArchiveAtRoot } from './project-owner-planning-doc-service'

function plan(state: ProjectOwnerPlanDraft['state'] = 'proposed'): ProjectOwnerPlanDraft {
  return {
    projectId: 'game-project', schemaVersion: 1, revision: state === 'confirmed' ? 2 : 1,
    planVersion: 1, goalRevision: 1, goalVersion: 1, state, actor: 'system:owner-planner', origin: 'generated',
    sourceRun: { receiptId: 'private-receipt-id', executionId: 'private-run-id', responseHash: 'private-hash' },
    savedAt: 1, changeReason: '初始提案', contextFingerprint: 'private-context', planFingerprint: 'plan-fingerprint',
    sources: { project: { id: 'game-project', title: '小游戏', description: '' }, roles: [{ key: 'design', name: '设计', version: '1', sourceSha256: 'source-hash', rulesSha256: 'rules-hash' }] },
    proposal: { projectId: 'game-project', goalVersion: 1, mode: 'proposal_only', summary: '围绕三消/连线消除 H5，先锁定规则与三关参数。', assumptions: ['面向移动端 Web H5 浏览器'], risks: ['关卡数值缺少用户测试，难度可能偏差'], steps: [{ key: 'rules', title: '建立三关验收与测试清单', outcome: '形成覆盖开始、重开、过关、计分和三关通关的验收清单', acceptanceCriteria: ['开始、重开、过关行为均有覆盖'], dependencies: [], roleKey: 'design' }] },
  }
}

test('Given 已保存规划版本 When 归档两次 Then 追加可读计划一次且不包含技术回执字段', () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-plan-doc-'))
  try {
    appendProjectOwnerPlanArchiveAtRoot(root, 'game-project', '小游戏', [plan()])
    appendProjectOwnerPlanArchiveAtRoot(root, 'game-project', '小游戏', [plan()])
    const markdown = readFileSync(join(root, 'docs', 'owner-planning-log.md'), 'utf8')
    expect(markdown.match(/<!-- owner-planning:/g)).toHaveLength(1)
    expect(markdown).toContain('计划 v1 · 待审阅')
    expect(markdown).toContain('建立三关验收与测试清单')
    expect(markdown).toContain('开始、重开、过关行为均有覆盖')
    for (const secret of ['private-receipt-id', 'private-run-id', 'private-hash', 'private-context', 'source-hash', 'rules-hash']) expect(markdown).not.toContain(secret)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given 提案随后被确认 When 归档历史 Then 追加确认事件且重复同步幂等', () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-plan-doc-state-'))
  try {
    appendProjectOwnerPlanArchiveAtRoot(root, 'game-project', '小游戏', [plan('proposed'), plan('confirmed')])
    appendProjectOwnerPlanArchiveAtRoot(root, 'game-project', '小游戏', [plan('proposed'), plan('confirmed')])
    const markdown = readFileSync(join(root, 'docs', 'owner-planning-log.md'), 'utf8')
    expect(markdown.match(/<!-- owner-planning:/g)).toHaveLength(2)
    expect(markdown).toContain('计划 v1 · 待审阅')
    expect(markdown).toContain('计划 v1 · 已确认内容')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given docs 目录是符号链接 When 写入规划文档 Then 拒绝越界且不碰链接目标', () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-plan-doc-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'owner-plan-doc-outside-'))
  try {
    symlinkSync(outside, join(root, 'docs'))
    expect(() => appendProjectOwnerPlanArchiveAtRoot(root, 'game-project', '小游戏', [plan()])).toThrow('安全目录')
    expect(existsSync(join(outside, 'owner-planning-log.md'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('Given 目标 Markdown 是符号链接 When 追加记录 Then 拒绝覆盖外部文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-plan-doc-target-'))
  const outside = mkdtempSync(join(tmpdir(), 'owner-plan-doc-target-outside-'))
  const outsideFile = join(outside, 'existing.md')
  try {
    mkdirSync(join(root, 'docs'))
    writeFileSync(outsideFile, 'user content\n')
    symlinkSync(outsideFile, join(root, 'docs', 'owner-planning-log.md'))
    expect(() => appendProjectOwnerPlanArchiveAtRoot(root, 'game-project', '小游戏', [plan()])).toThrow('普通文件')
    expect(readFileSync(outsideFile, 'utf8')).toBe('user content\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
