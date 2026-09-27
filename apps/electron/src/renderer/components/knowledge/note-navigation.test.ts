import { describe, expect, test } from 'bun:test'
import type { KnowledgeNote } from '@gravitas/shared'
import { resolveNoteLink } from './note-navigation'

function note(id: string, filePath: string, title: string, vaultId = 'vault'): KnowledgeNote {
  return {
    id, filePath, title, vaultId, content: '', rawContent: '', tags: [], links: [],
    backlinks: [], frontmatter: {}, wordCount: 0, createdAt: '', updatedAt: '', indexedAt: '',
  }
}

const source = note('source', 'docs/目录.md', '目录')
const notes = [
  source,
  note('near', 'docs/目标.md', '目标'),
  note('deep', 'research/案例.md', '案例标题'),
  note('duplicate-a', 'a/同名.md', '同名'),
  note('duplicate-b', 'b/同名.md', '同名'),
  note('other-vault', 'docs/目标.md', '目标', 'other'),
]

describe('知识库笔记链接导航', () => {
  test('Markdown 相对路径、编码路径和标题锚点', () => {
    expect(resolveNoteLink(notes, source, './%E7%9B%AE%E6%A0%87.md#%E7%BB%93%E8%AE%BA', 'markdown'))
      .toEqual({ note: notes[1]!, fragment: '结论' })
    expect(resolveNoteLink(notes, source, '../research/案例.md', 'markdown')?.note.id).toBe('deep')
    expect(resolveNoteLink(notes, source, '/research/案例.md', 'markdown')?.note.id).toBe('deep')
    expect(resolveNoteLink(notes, source, '#摘要', 'markdown'))
      .toEqual({ note: source, fragment: '摘要' })
  })

  test('双链支持 Vault 根目录路径、相对路径与别名对应的标题', () => {
    expect(resolveNoteLink(notes, source, 'research/案例', 'wiki')?.note.id).toBe('deep')
    expect(resolveNoteLink(notes, source, '目标', 'wiki')?.note.id).toBe('near')
    expect(resolveNoteLink(notes, source, '案例标题', 'wiki')?.note.id).toBe('deep')
  })

  test('同名目标和越出 Vault 的路径保持未解析', () => {
    expect(resolveNoteLink(notes, source, '同名', 'wiki')).toBeNull()
    expect(resolveNoteLink(notes, source, '../../outside.md', 'markdown')).toBeNull()
  })
})
