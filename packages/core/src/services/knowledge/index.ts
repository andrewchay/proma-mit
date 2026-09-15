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

// ===== 笔记序列化 =====

/** frontmatter 值序列化：数组写成 [a, b]，其余按字符串处理 */
function serializeFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => String(v)).join(', ')}]`
  }
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * 需要加引号的值。
 *
 * 数组字面量（已序列化为 [a, b]）不能加引号，否则会变成字符串而
 * 丢失数组语义，因此由调用方单独判断。
 */
function needsQuoting(raw: string): boolean {
  if (/^\[.*\]$/.test(raw)) return false
  // YAML 中冒号后跟空格会开启映射，必须引起来；# 开头会被当作注释
  return /^[\s]|[\s]$|:\s|^#|[{}"]|^$/.test(raw)
}

/**
 * 从正文中剥离与标题相同的一级标题行。
 *
 * parseNote 的 content 包含整个 body（含一级标题），而序列化会重新
 * 生成标题。不剥离会使「读取 → 保存」每次都多出一行标题。
 */
function stripDuplicateHeading(content: string, title: string): string {
  const trimmed = content.trimStart()
  const match = trimmed.match(/^#\s+(.+)\r?\n?/)
  if (match) {
    const heading = match[1]?.trim()
    // 仅当标题一致时剥离；不一致说明用户改过标题，应保留
    if (heading === title.trim()) {
      return trimmed.slice(match[0].length)
    }
  }
  return content
}

/**
 * 从结构化字段生成 Markdown 文件内容。
 *
 * 与 parseNote 成对：generateNoteContent 的输出必须能被 parseNote
 * 解析回等价结构，否则每次「读取 → 保存」都会让文件漂移。
 *
 * 磁盘上只保留标准 Markdown 与 YAML frontmatter，不写入任何工具专用
 * 标记，保证 Obsidian 等其他编辑器能正常读取。
 */
export function generateNoteContent(input: {
  title: string
  content: string
  frontmatter?: Record<string, unknown>
}): string {
  const { frontmatter, content } = input

  // title 统一进 frontmatter 会与一级标题重复；这里约定：
  // frontmatter 只保留调用方显式给出的键，标题由正文一级标题承载。
  const entries = Object.entries(frontmatter ?? {}).filter(([, v]) => v !== undefined && v !== null)

  const parts: string[] = []

  if (entries.length > 0) {
    parts.push('---')
    for (const [key, value] of entries) {
      const serialized = serializeFrontmatterValue(value)
      parts.push(
        `${key}: ${needsQuoting(serialized) ? `"${serialized.replace(/"/g, '\\"')}"` : serialized}`,
      )
    }
    parts.push('---')
    parts.push('')
  }

  parts.push(`# ${input.title}`)

  // 正文：剥离重复标题后按段拼接，避免空正文留下多余空行
  const body = stripDuplicateHeading(content, input.title).trim()
  if (body) {
    parts.push('')
    parts.push(body)
  }

  return `${parts.join('\n')}\n`
}

// ===== 稳定标识与路径规范化 =====

/**
 * 稳定笔记 id。
 *
 * 由 vaultId + 相对路径派生，因此同一文件在多次索引间 id 保持一致。
 * 不用 randomUUID：那会让「打开笔记 → 后台索引 → 保存」因为 id 变化而
 * 定位失败。
 *
 * 用相对路径而非标题：标题允许重复，相对路径在 Vault 内唯一。
 *
 * 注意：这里用同步的简单哈希而非 crypto，以便 core 保持零 Node 依赖；
 * 该 id 只用于本地索引定位，不承载安全语义。
 */
export function stableNoteId(vaultId: string, relativePath: string): string {
  const input = `${vaultId}:${normalizeRelPath(relativePath)}`
  // FNV-1a 32 位 ×2（不同偏移）拼成 16 位十六进制，碰撞概率足以满足本地索引
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/**
 * 统一相对路径分隔符。
 *
 * 同时处理两种分隔符：不能只依赖平台的 sep，因为以反斜杠输入的路径在
 * macOS/Linux 上不会被替换，会导致跨平台 id 不一致。
 */
export function normalizeRelPath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

// ===== 分块（K1-03）=====

export {
  chunkDocument,
  MAX_CHUNK_CHARS,
} from './chunking.ts'
export type { DocumentChunk } from './chunking.ts'
