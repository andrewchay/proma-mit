/**
 * RIS / BibTeX 文献导入解析（M2，纯函数无 IO）
 *
 * 目标不是完整的引文管理兼容层，而是把用户从 Zotero/数据库
 * 导出的标准格式可靠地解析为书目草稿。解析失败的部分跳过并
 * 返回，而不是让一条坏记录毁掉整批导入。
 */

import type { ExternalId, SourceType } from '@gravitas/shared'
import { makeExternalId } from './source-identity'

/** 书目草稿：还没有分配 sourceId/versionId，由服务层落库时生成 */
export interface BibliographicDraft {
  title: string
  authors: string[]
  year?: number
  venue?: string
  abstract?: string
  externalIds: ExternalId[]
  sourceType: SourceType
}

// ===== BibTeX =====

interface RawBibtexEntry {
  entryType: string
  fields: Record<string, string>
}

/** 提取顶层 @type{key, ...} 条目（容忍嵌套花括号） */
function extractBibtexEntries(input: string): RawBibtexEntry[] {
  const entries: RawBibtexEntry[] = []
  const entryRegex = /@(\w+)\s*\{/g
  let match: RegExpExecArray | null

  while ((match = entryRegex.exec(input)) !== null) {
    const entryType = match[1]!.toLowerCase()
    let depth = 1
    let end = entryRegex.lastIndex
    while (end < input.length && depth > 0) {
      const ch = input[end]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      end++
    }
    if (depth !== 0) continue // 未闭合：跳过该条目

    const body = input.slice(entryRegex.lastIndex, end - 1)
    // 去掉 key（第一个逗号之前）
    const bodyWithoutKey = body.slice(body.indexOf(',') + 1)

    const fields: Record<string, string> = {}
    // 手写扫描：name = {平衡花括号} 或 name = "引号串"
    // （正则反向引用无法表达 BibTeX 的 {} 配对）
    const fieldStart = /(\w+)\s*=\s*([{"])/g
    let fm: RegExpExecArray | null
    while ((fm = fieldStart.exec(bodyWithoutKey)) !== null) {
      const name = fm[1]!.toLowerCase()
      const openCh = fm[2]!
      let end = fieldStart.lastIndex
      if (openCh === '{') {
        let depth = 1
        while (end < bodyWithoutKey.length && depth > 0) {
          const ch = bodyWithoutKey[end]
          if (ch === '{') depth++
          else if (ch === '}') depth--
          end++
        }
        fields[name] = bodyWithoutKey.slice(fieldStart.lastIndex, end - 1).trim()
      } else {
        const closeQuote = bodyWithoutKey.indexOf('"', end)
        if (closeQuote === -1) break
        fields[name] = bodyWithoutKey.slice(end, closeQuote).trim()
        end = closeQuote + 1
      }
      fieldStart.lastIndex = end
    }

    entries.push({ entryType, fields })
    entryRegex.lastIndex = end
  }

  return entries
}

/** 把 "Smith, Jane and Doe, John" 拆成作者列表 */
function splitBibtexAuthors(raw: string): string[] {
  return raw
    .split(/\s+and\s+/i)
    .map((a) => a.trim())
    .filter(Boolean)
}

function mapBibtexType(entryType: string): SourceType {
  switch (entryType) {
    case 'article':
      return 'journal-article'
    case 'book':
      return 'book'
    case 'inbook':
    case 'incollection':
      return 'book-chapter'
    case 'phdthesis':
    case 'mastersthesis':
      return 'thesis'
    case 'misc':
    case 'online':
      return 'other'
    default:
      return 'other'
  }
}

function extractExternalIds(fields: Record<string, string>): ExternalId[] {
  const ids: ExternalId[] = []
  if (fields.doi) ids.push(makeExternalId('doi', fields.doi))
  if (fields.isbn) ids.push(makeExternalId('isbn', fields.isbn))
  if (fields.eprint && fields.archiveprefix?.toLowerCase() === 'arxiv') {
    ids.push(makeExternalId('arxiv', fields.eprint))
  }
  if (fields.pmid) ids.push(makeExternalId('pmid', fields.pmid))
  return ids
}

/** 解析 BibTeX 文本；未识别或未闭合的条目被跳过 */
export function parseBibtex(input: string): BibliographicDraft[] {
  const drafts: BibliographicDraft[] = []

  for (const entry of extractBibtexEntries(input)) {
    const { fields } = entry
    if (!fields.title) continue

    drafts.push({
      title: fields.title,
      authors: fields.author ? splitBibtexAuthors(fields.author) : [],
      year: fields.year ? parseInt(fields.year, 10) || undefined : undefined,
      venue: fields.journal ?? fields.booktitle ?? fields.publisher,
      abstract: fields.abstract,
      externalIds: extractExternalIds(fields),
      sourceType: mapBibtexType(entry.entryType),
    })
  }

  return drafts
}

// ===== RIS =====

/** 解析 RIS 文本；按 ER 行分割记录，坏记录跳过 */
export function parseRis(input: string): BibliographicDraft[] {
  const drafts: BibliographicDraft[] = []

  const records: string[][] = [[]]
  for (const line of input.split(/\r?\n/)) {
    if (/^ER\s{2}-\s*$/.test(line)) {
      records.push([])
      continue
    }
    if (/^([A-Z0-9]{2})\s{2}-\s?(.*)$/.test(line)) {
      records[records.length - 1]!.push(line)
    }
  }

  for (const lines of records) {
    const tags = new Map<string, string[]>()
    for (const line of lines) {
      const m = line.match(/^([A-Z0-9]{2})\s{2}-\s?(.*)$/)
      if (!m) continue
      const tag = m[1]!
      const list = tags.get(tag) ?? []
      list.push(m[2]!.trim())
      tags.set(tag, list)
    }

    const title = tags.get('TI')?.[0] ?? tags.get('T1')?.[0]
    if (!title) continue

    const typeTag = tags.get('TY')?.[0] ?? tags.get('PT')?.[0] ?? ''
    const yearRaw = tags.get('PY')?.[0] ?? tags.get('Y1')?.[0] ?? ''
    const yearMatch = yearRaw.match(/(\d{4})/)

    const externalIds: ExternalId[] = []
    if (tags.get('DO')?.[0]) externalIds.push(makeExternalId('doi', tags.get('DO')![0]!))
    if (tags.get('SN')?.[0] && /^(97[89])/.test(tags.get('SN')![0]!)) {
      externalIds.push(makeExternalId('isbn', tags.get('SN')![0]!))
    }
    for (const u of tags.get('UR') ?? []) {
      const arxiv = u.match(/arxiv\.org\/abs\/([^\s]+)/i)
      if (arxiv) externalIds.push(makeExternalId('arxiv', arxiv[1]!))
      else externalIds.push(makeExternalId('url', u))
    }

    const sourceType: SourceType = /^BOOK$/i.test(typeTag)
      ? 'book'
      : /^THES$/i.test(typeTag)
        ? 'thesis'
        : /^CHAP$/i.test(typeTag)
          ? 'book-chapter'
          : 'journal-article'

    drafts.push({
      title,
      authors: [...(tags.get('AU') ?? []), ...(tags.get('A1') ?? [])],
      year: yearMatch ? parseInt(yearMatch[1]!, 10) : undefined,
      venue: tags.get('JO')?.[0] ?? tags.get('JF')?.[0] ?? tags.get('T2')?.[0],
      abstract: tags.get('AB')?.[0] ?? tags.get('N2')?.[0],
      externalIds,
      sourceType,
    })
  }

  return drafts
}
