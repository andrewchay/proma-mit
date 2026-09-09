import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolvePlanDocument, isPlanDocumentCurrent } from './agent-plan-document'

describe('Plan 审批文档', () => {
  test('只接受会话 plan 目录内的 Markdown，并在内容变化后判定为过期', () => {
    const root = mkdtempSync(join(tmpdir(), 'gravitas-plan-'))
    const planDirectory = join(root, '.context', 'plan')
    mkdirSync(planDirectory, { recursive: true })
    const planFile = join(planDirectory, 'release.md')
    writeFileSync(planFile, '# 发布计划\n')

    const document = resolvePlanDocument(planFile, planDirectory)

    expect(document?.displayName).toBe('release.md')
    expect(isPlanDocumentCurrent(document!, planDirectory)).toBe(true)
    writeFileSync(planFile, '# 已被替换的计划\n')
    expect(isPlanDocumentCurrent(document!, planDirectory)).toBe(false)
  })

  test('拒绝越界文件和指向越界位置的符号链接', () => {
    const root = mkdtempSync(join(tmpdir(), 'gravitas-plan-'))
    const planDirectory = join(root, '.context', 'plan')
    mkdirSync(planDirectory, { recursive: true })
    const outside = join(root, 'outside.md')
    writeFileSync(outside, '# 外部计划\n')
    const linked = join(planDirectory, 'linked.md')
    symlinkSync(outside, linked)

    expect(resolvePlanDocument(outside, planDirectory)).toBeUndefined()
    expect(resolvePlanDocument(linked, planDirectory)).toBeUndefined()
  })
})
