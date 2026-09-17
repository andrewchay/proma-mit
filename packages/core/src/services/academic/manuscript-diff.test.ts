import { describe, expect, test } from 'bun:test'

/**
 * 稿件版本 diff 测试（M7.3）：
 * - 章节级 added/removed/modified/unchanged
 * - 行级差异可读
 * - **主张引用增删单独暴露**（文字未变但引用变化必须可见）
 */

const { describeDiffSummary, diffManuscriptVersions } = await import('@gravitas/core/services/academic')

function version(
  versionNum: number,
  sections: Array<{ heading: string; content: string; claimIds?: string[] }>,
  changeReason?: string,
) {
  return {
    id: `m-${versionNum}`,
    projectId: 'p',
    version: versionNum,
    title: '稿件',
    sections: sections.map((s, i) => ({
      id: `s${versionNum}-${i}`,
      heading: s.heading,
      content: s.content,
      claimIds: s.claimIds ?? [],
      citationRefs: [],
    })),
    changeReason,
    createdBy: { id: 'local-user', displayName: '本机用户', trusted: true },
    createdAt: '2026-09-17T00:00:00.000Z',
  }
}

describe('章节变更识别', () => {
  test('modified：内容变化时给出行级差异', () => {
    const from = version(1, [{ heading: '引言', content: '第一行\n第二行' }])
    const to = version(2, [{ heading: '引言', content: '第一行\n第二行已改写' }], '回应审稿意见 1')

    const diff = diffManuscriptVersions(from as never, to as never)
    const intro = diff.sections.find((s) => s.heading === '引言')!
    expect(intro.change).toBe('modified')
    expect(intro.lines.some((l) => l.type === 'removed' && l.text === '第二行')).toBe(true)
    expect(intro.lines.some((l) => l.type === 'added' && l.text === '第二行已改写')).toBe(true)
    expect(diff.changeReason).toBe('回应审稿意见 1')
  })

  test('added / removed / unchanged', () => {
    const from = version(1, [
      { heading: '引言', content: 'A' },
      { heading: '方法', content: 'B' },
    ])
    const to = version(2, [
      { heading: '引言', content: 'A' },
      { heading: '结果', content: 'C' },
    ], '重构结构')

    const diff = diffManuscriptVersions(from as never, to as never)
    expect(diff.sections.find((s) => s.heading === '引言')!.change).toBe('unchanged')
    expect(diff.sections.find((s) => s.heading === '方法')!.change).toBe('removed')
    expect(diff.sections.find((s) => s.heading === '结果')!.change).toBe('added')
  })
})

describe('主张引用增删（关键可见性）', () => {
  test('文字未变但引用变化 → 章节仍标 modified，并列出增删', () => {
    const from = version(1, [{ heading: '结果', content: '相同内容', claimIds: ['c1', 'c2'] }])
    const to = version(2, [{ heading: '结果', content: '相同内容', claimIds: ['c2', 'c3'] }], '更换依据')

    const diff = diffManuscriptVersions(from as never, to as never)
    const results = diff.sections.find((s) => s.heading === '结果')!
    // 正文一字未改，但引用变了——不能显示为 unchanged
    expect(results.change).toBe('modified')
    expect(results.claimsAdded).toEqual(['c3'])
    expect(results.claimsRemoved).toEqual(['c1'])
    expect(diff.claimsAdded).toEqual(['c3'])
    expect(diff.claimsRemoved).toEqual(['c1'])
  })

  test('无变化时 summary 如实说明未变化', () => {
    const from = version(1, [{ heading: '引言', content: 'A', claimIds: ['c1'] }])
    const to = version(2, [{ heading: '引言', content: 'A', claimIds: ['c1'] }], '仅版本号推进')

    const diff = diffManuscriptVersions(from as never, to as never)
    expect(diff.sections[0]!.change).toBe('unchanged')
    expect(describeDiffSummary(diff)).toContain('内容未发生变化')
  })
})

describe('变更摘要', () => {
  test('摘要列出章节与引用变化，不夸大', () => {
    const from = version(1, [
      { heading: '引言', content: 'A' },
      { heading: '方法', content: 'B', claimIds: ['c1'] },
    ])
    const to = version(2, [
      { heading: '引言', content: 'A 已改' },
      { heading: '方法', content: 'B', claimIds: ['c1', 'c2'] },
      { heading: '局限', content: 'D' },
    ], '补充局限')

    const summary = describeDiffSummary(diffManuscriptVersions(from as never, to as never))
    expect(summary).toContain('修改章节：引言、方法')
    expect(summary).toContain('新增章节：局限')
    expect(summary).toContain('新增主张引用 1 条')
    expect(summary).toContain('v1 → v2')
  })
})
