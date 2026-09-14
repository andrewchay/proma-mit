/**
 * 知识库纯算法模块
 *
 * 从 PAA knowledge-service.ts 提取的纯函数，无 Electron/Node 依赖。
 * 包含 Markdown 解析、wikilink 提取、标签提取、相似度计算等核心算法。
 */

// ===== Markdown 解析 =====

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>
  body: string
}

/**
 * 解析 YAML frontmatter（简单子集：key: value 和 key: [a, b, c]）
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const fmText = match[1] || ''
  const body = content.slice(match[0].length)
  const frontmatter: Record<string, unknown> = {}

  for (const line of fmText.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()

    if (value.startsWith('[') && value.endsWith(']')) {
      try {
        frontmatter[key] = value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean)
      } catch {
        frontmatter[key] = value
      }
    } else {
      frontmatter[key] = value.replace(/^["']|["']$/g, '')
    }
  }

  return { frontmatter, body }
}

/**
 * 提取 [[wikilink]] 目标
 */
export function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]]+)\]\]/g
  const matches = Array.from(content.matchAll(regex))
  for (const match of matches) {
    const link = match[1]?.split('|')?.[0]?.trim()
    if (link && !links.includes(link)) {
      links.push(link)
    }
  }
  return links
}

/**
 * 提取 #tag 标签（支持中文）
 */
export function extractTags(content: string): string[] {
  const tags: string[] = []
  const regex = /#([\w\-\u4e00-\u9fa5]+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    const tag = match[1]
    if (tag && !tags.includes(tag)) {
      tags.push(tag)
    }
  }
  return tags
}

/**
 * 统计字数（中文字符 + 英文单词）
 */
export function countWords(text: string): number {
  const chinese = text.match(/[\u4e00-\u9fa5]/g) || []
  const english = text.match(/[a-zA-Z]+/g) || []
  return chinese.length + english.length
}

// ===== 相似度计算 =====

/**
 * 计算两段文本的相似度（0-100）
 * 基于共同词/字符的比例，支持中文（2-gram）和英文（单词）
 */
export function calculateSimilarity(a: string, b: string): number {
  const extractTokens = (text: string): Set<string> => {
    const tokens = new Set<string>()
    // 英文单词
    const words = text.toLowerCase().match(/[a-z]{3,}/g) || []
    for (const w of words) tokens.add(w)
    // 中文字符（2-gram）
    const chinese = text.match(/[\u4e00-\u9fa5]/g) || []
    for (let i = 0; i < chinese.length - 1; i++) {
      tokens.add(chinese[i]! + chinese[i + 1]!)
    }
    return tokens
  }

  const wordsA = extractTokens(a)
  const wordsB = extractTokens(b)
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)))
  const union = new Set([...wordsA, ...wordsB])
  return union.size > 0 ? Math.round((intersection.size / union.size) * 100) : 0
}

// ===== 笔记解析 =====

export interface ParsedNote {
  frontmatter: Record<string, unknown>
  content: string
  rawContent: string
  title: string
  tags: string[]
  links: string[]
  wordCount: number
}

/**
 * 解析 Markdown 文件内容为结构化笔记
 */
export function parseNote(rawContent: string, fileName: string): ParsedNote {
  const { frontmatter, body } = parseFrontmatter(rawContent)

  // 标题：frontmatter.title > 文件名 > 第一行标题
  const firstHeading = body.match(/^#\s+(.+)/m)?.[1]
  const title = (frontmatter.title as string) || firstHeading || fileName

  const tags = [
    ...extractTags(body),
    ...extractTags(rawContent),
    ...(Array.isArray(frontmatter.tags) ? frontmatter.tags : []),
  ]
  const uniqueTags = [...new Set(tags)]

  const links = extractWikilinks(rawContent)

  return {
    frontmatter,
    content: body.trim(),
    rawContent,
    title,
    tags: uniqueTags,
    links,
    wordCount: countWords(body),
  }
}

// ===== 图谱构建 =====

export interface GraphNode {
  id: string
  label: string
  type: 'note' | 'tag'
  count?: number
}

export interface GraphEdge {
  source: string
  target: string
  type: 'link' | 'backlink' | 'tag'
}

export interface KnowledgeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * 从笔记列表构建知识图谱
 */
export function buildGraph(
  notes: Array<{
    id: string
    title: string
    filePath: string
    tags: string[]
    links: string[]
  }>,
): KnowledgeGraph {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const nodeIds = new Set<string>()

  // 笔记节点
  for (const note of notes) {
    if (!nodeIds.has(note.id)) {
      nodes.push({ id: note.id, label: note.title, type: 'note' })
      nodeIds.add(note.id)
    }
  }

  // 标签节点 + 边
  const tagCounts: Record<string, number> = {}
  for (const note of notes) {
    for (const tag of note.tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1
      const tagId = `tag:${tag}`
      if (!nodeIds.has(tagId)) {
        nodes.push({ id: tagId, label: `#${tag}`, type: 'tag', count: tagCounts[tag] })
        nodeIds.add(tagId)
      }
      edges.push({ source: note.id, target: tagId, type: 'tag' })
    }
  }

  // 链接边
  const titleToId: Record<string, string> = {}
  for (const note of notes) {
    titleToId[note.title] = note.id
    const baseName = note.filePath.split('/').pop()?.replace(/\.md$/, '') || ''
    if (!titleToId[baseName]) {
      titleToId[baseName] = note.id
    }
  }

  for (const note of notes) {
    for (const link of note.links) {
      const targetId = titleToId[link]
      if (targetId && targetId !== note.id) {
        const exists = edges.some(
          (e) => e.source === note.id && e.target === targetId && e.type === 'link',
        )
        if (!exists) {
          edges.push({ source: note.id, target: targetId, type: 'link' })
        }
      }
    }
  }

  return { nodes, edges }
}

// ===== 搜索 =====

export interface SearchableNote {
  id: string
  title: string
  content: string
  tags: string[]
  links: string[]
}

export interface SearchResult {
  note: SearchableNote
  score: number
  highlights: string[]
  matchType: 'title' | 'content' | 'tag' | 'link'
}

/**
 * 搜索笔记（标题 > 标签 > 链接 > 内容）
 */
export function searchNotes(
  notes: SearchableNote[],
  query: string,
): SearchResult[] {
  if (!query || !query.trim()) {
    return notes.map((n) => ({ note: n, score: 1, highlights: [], matchType: 'title' as const }))
  }

  const q = query.toLowerCase().trim()
  const results: SearchResult[] = []

  for (const note of notes) {
    let score = 0
    const highlights: string[] = []
    let matchType: SearchResult['matchType'] = 'content'

    // 标题匹配（权重最高）
    if (note.title.toLowerCase().includes(q)) {
      score += 10
      matchType = 'title'
      highlights.push(note.title)
    }

    // 标签匹配
    const matchingTags = note.tags.filter((t) => t.toLowerCase().includes(q))
    if (matchingTags.length > 0) {
      score += 8
      matchType = 'tag'
      highlights.push(...matchingTags.map((t) => `#${t}`))
    }

    // 链接匹配
    const matchingLinks = note.links.filter((l) => l.toLowerCase().includes(q))
    if (matchingLinks.length > 0) {
      score += 5
      matchType = 'link'
      highlights.push(...matchingLinks.map((l) => `[[${l}]]`))
    }

    // 内容匹配
    const contentLower = note.content.toLowerCase()
    if (contentLower.includes(q)) {
      score += 3
      const idx = contentLower.indexOf(q)
      const start = Math.max(0, idx - 40)
      const end = Math.min(note.content.length, idx + q.length + 40)
      const snippet = note.content.slice(start, end)
      highlights.push(snippet)
    }

    if (score > 0) {
      results.push({
        note,
        score,
        highlights: highlights.slice(0, 3),
        matchType,
      })
    }
  }

  return results.sort((a, b) => b.score - a.score)
}

// ===== 重复检测 =====

export interface DuplicateGroup {
  notes: Array<{
    noteId: string
    noteTitle: string
    similarity: number
    reason: string
  }>
  suggestedAction: 'merge' | 'review' | 'ignore'
}

/**
 * 检测重复笔记（基于标题、内容、标签的多维度相似度）
 */
export function detectDuplicates(
  notes: Array<{
    id: string
    title: string
    content: string
    tags: string[]
  }>,
  threshold: number = 60,
): DuplicateGroup[] {
  const groups: DuplicateGroup[] = []
  const processed = new Set<string>()

  for (let i = 0; i < notes.length; i++) {
    const noteA = notes[i]
    if (!noteA || processed.has(noteA.id)) continue

    const duplicates: DuplicateGroup['notes'] = []

    for (let j = i + 1; j < notes.length; j++) {
      const noteB = notes[j]
      if (!noteB || processed.has(noteB.id)) continue

      // 标题相似度
      const titleSim = calculateSimilarity(noteA.title, noteB.title)
      // 内容相似度
      const contentSim = calculateSimilarity(
        noteA.content.slice(0, 500),
        noteB.content.slice(0, 500),
      )
      // 标签重叠
      const tagOverlap = noteA.tags.filter((t) => noteB.tags.includes(t)).length
      const tagSim =
        noteA.tags.length > 0
          ? Math.round((tagOverlap / Math.max(noteA.tags.length, noteB.tags.length)) * 100)
          : 0

      const overallSim = Math.round(titleSim * 0.4 + contentSim * 0.4 + tagSim * 0.2)

      if (overallSim >= threshold) {
        duplicates.push({
          noteId: noteB.id,
          noteTitle: noteB.title,
          similarity: overallSim,
          reason: titleSim > 80 ? '标题高度相似' : contentSim > 80 ? '内容高度相似' : '多维度相似',
        })
        processed.add(noteB.id)
      }
    }

    if (duplicates.length > 0) {
      duplicates.unshift({
        noteId: noteA.id,
        noteTitle: noteA.title,
        similarity: 100,
        reason: '基准笔记',
      })
      groups.push({
        notes: duplicates,
        suggestedAction: duplicates.some((d) => d.similarity > 90) ? 'merge' : 'review',
      })
      processed.add(noteA.id)
    }
  }

  return groups.sort((a, b) => {
    const maxSimA = Math.max(...a.notes.map((n) => n.similarity))
    const maxSimB = Math.max(...b.notes.map((n) => n.similarity))
    return maxSimB - maxSimA
  })
}

// ===== 链接建议 =====

export interface LinkSuggestion {
  sourceId: string
  sourceTitle: string
  targetId: string
  targetTitle: string
  confidence: number
  reason: string
}

/**
 * 建议笔记间的潜在链接（基于内容相似度和标签重叠）
 */
export function suggestLinks(
  notes: Array<{
    id: string
    title: string
    content: string
    tags: string[]
    links: string[]
  }>,
  threshold: number = 50,
  limit: number = 20,
): LinkSuggestion[] {
  const suggestions: LinkSuggestion[] = []

  for (let i = 0; i < notes.length; i++) {
    const source = notes[i]
    if (!source) continue

    for (let j = 0; j < notes.length; j++) {
      if (i === j) continue
      const target = notes[j]
      if (!target) continue

      // 跳过已有链接的
      if (source.links.includes(target.title) || target.links.includes(source.title)) continue

      // 内容相似度
      const contentSim = calculateSimilarity(
        source.content.slice(0, 300),
        target.content.slice(0, 300),
      )
      // 标签重叠
      const tagOverlap = source.tags.filter((t) => target.tags.includes(t)).length
      const tagSim =
        source.tags.length > 0
          ? Math.round((tagOverlap / Math.max(source.tags.length, target.tags.length)) * 100)
          : 0

      const confidence = Math.round(contentSim * 0.6 + tagSim * 0.4)

      if (confidence >= threshold) {
        suggestions.push({
          sourceId: source.id,
          sourceTitle: source.title,
          targetId: target.id,
          targetTitle: target.title,
          confidence,
          reason: tagOverlap > 0 ? `共享 ${tagOverlap} 个标签` : '内容高度相关',
        })
      }
    }
  }

  // 去重（双向建议只保留一个）
  const seen = new Set<string>()
  const unique: LinkSuggestion[] = []
  for (const s of suggestions) {
    const key = [s.sourceId, s.targetId].sort().join('-')
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(s)
    }
  }

  return unique.sort((a, b) => b.confidence - a.confidence).slice(0, limit)
}
