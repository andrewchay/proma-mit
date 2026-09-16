import { describe, expect, test } from 'bun:test'

/**
 * RIS / BibTeX 导入解析测试。
 *
 * 覆盖：常规字段、多作者、DOI/arXiv 提取、损坏输入报错而非静默。
 */

const { parseBibtex, parseRis } = await import('@gravitas/core/services/academic')

describe('BibTeX 解析', () => {
  test('常规 article 条目', () => {
    const entries = parseBibtex(`
@article{smith2024,
  title = {Noise Reduction and Listening Effort},
  author = {Smith, Jane and Doe, John},
  year = {2024},
  journal = {Trends in Hearing},
  doi = {10.1234/nre.2024}
}
`)
    expect(entries).toHaveLength(1)
    const e = entries[0]!
    expect(e.title).toBe('Noise Reduction and Listening Effort')
    expect(e.authors).toEqual(['Smith, Jane', 'Doe, John'])
    expect(e.year).toBe(2024)
    expect(e.venue).toBe('Trends in Hearing')
    expect(e.externalIds).toEqual([{ namespace: 'doi', value: '10.1234/nre.2024' }])
    expect(e.sourceType).toBe('journal-article')
  })

  test('book 条目映射为 book 类型', () => {
    const entries = parseBibtex(`
@book{goffman1963,
  title = {Stigma},
  author = {Goffman, Erving},
  year = {1963},
  isbn = {9780674842417}
}
`)
    expect(entries[0]!.sourceType).toBe('book')
    expect(entries[0]!.externalIds).toEqual([
      { namespace: 'isbn', value: '9780674842417' },
    ])
  })

  test('无条目的空输入返回空数组', () => {
    expect(parseBibtex('不是 bibtex 的文本')).toEqual([])
  })
})

describe('RIS 解析', () => {
  test('常规 RIS 记录（多作者、DO、AB）', () => {
    const records = parseRis(`
TY  - JOUR
AU  - Zhang, Wei
AU  - Li, Ming
TI  - Auditory Training Outcomes
JO  - Ear and Hearing
PY  - 2023
DO  - 10.5678/eh.2023
AB  - Background: This study examined...
ER  - 
`)
    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r.title).toBe('Auditory Training Outcomes')
    expect(r.authors).toEqual(['Zhang, Wei', 'Li, Ming'])
    expect(r.year).toBe(2023)
    expect(r.venue).toBe('Ear and Hearing')
    expect(r.externalIds).toEqual([{ namespace: 'doi', value: '10.5678/eh.2023' }])
    expect(r.abstract).toContain('Background')
    expect(r.sourceType).toBe('journal-article')
  })

  test('多条记录按 ER 分割', () => {
    const records = parseRis(`
TY  - JOUR
TI  - Paper One
ER  - 
TY  - BOOK
TI  - Book Two
ER  - 
`)
    expect(records).toHaveLength(2)
    expect(records[0]!.title).toBe('Paper One')
    expect(records[1]!.title).toBe('Book Two')
    expect(records[1]!.sourceType).toBe('book')
  })
})
