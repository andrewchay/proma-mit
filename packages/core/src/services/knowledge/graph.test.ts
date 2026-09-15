import { describe, expect, test } from 'bun:test'
import { buildGraph } from './index.ts'

/**
 * 图谱构建测试（K1-06 第一步：解析身份）。
 *
 * 双链解析最危险的错误不是少连边，而是错连：两个同名笔记中静默挑一个，
 * 用户在图上看到的"关联"就指向了错误目标。多义键宁可断开。
 */

describe('图谱双链解析', () => {
  test('唯一命中的双链正常连边', () => {
    const graph = buildGraph([
      { id: 'a', title: '架构', filePath: 'docs/架构.md', tags: [], links: ['权限'] },
      { id: 'b', title: '权限', filePath: 'docs/权限.md', tags: [], links: [] },
    ])

    expect(graph.edges.some((e) => e.source === 'a' && e.target === 'b' && e.type === 'link')).toBe(true)
  })

  test('同名标题的多义链接不自动连边', () => {
    const graph = buildGraph([
      { id: 'a', title: '随笔', filePath: 'folder1/随笔.md', tags: [], links: ['笔记'] },
      { id: 'n1', title: '笔记', filePath: 'a/笔记.md', tags: [], links: [] },
      { id: 'n2', title: '笔记', filePath: 'b/笔记.md', tags: [], links: [] },
    ])

    expect(graph.edges.filter((e) => e.type === 'link' && e.source === 'a')).toHaveLength(0)
  })

  test('同名文件名（不同目录）同样不连边', () => {
    const graph = buildGraph([
      { id: 'x', title: '索引', filePath: '索引.md', tags: [], links: ['README'] },
      { id: 'r1', title: '说明一', filePath: 'zh/README.md', tags: [], links: [] },
      { id: 'r2', title: '说明二', filePath: 'en/README.md', tags: [], links: [] },
    ])

    expect(graph.edges.filter((e) => e.type === 'link' && e.target.startsWith('r'))).toHaveLength(0)
  })

  test('重名不影响其他唯一链接', () => {
    const graph = buildGraph([
      { id: 'a', title: '甲', filePath: '甲.md', tags: [], links: ['笔记', '唯一'] },
      { id: 'n1', title: '笔记', filePath: 'a/笔记.md', tags: [], links: [] },
      { id: 'n2', title: '笔记', filePath: 'b/笔记.md', tags: [], links: [] },
      { id: 'u', title: '唯一', filePath: '唯一.md', tags: [], links: [] },
    ])

    expect(graph.edges.some((e) => e.source === 'a' && e.target === 'u' && e.type === 'link')).toBe(true)
    expect(graph.edges.filter((e) => e.source === 'a' && e.type === 'link')).toHaveLength(1)
  })

  test('自链接不产生边', () => {
    const graph = buildGraph([
      { id: 'a', title: '自引', filePath: '自引.md', tags: [], links: ['自引'] },
    ])
    expect(graph.edges.filter((e) => e.type === 'link')).toHaveLength(0)
  })
})
