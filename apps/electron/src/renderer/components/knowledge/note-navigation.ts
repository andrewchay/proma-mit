import type { KnowledgeNote } from '@gravitas/shared'

export interface ResolvedNoteLink {
  note: KnowledgeNote
  fragment: string | null
}

export type NoteLinkKind = 'wiki' | 'markdown'

function decodeLink(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizePath(path: string): string | null {
  const parts: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/').toLowerCase()
}

function uniqueMatch(notes: KnowledgeNote[], predicate: (note: KnowledgeNote) => boolean): KnowledgeNote | null {
  const matches = notes.filter(predicate)
  return matches.length === 1 ? matches[0]! : null
}

/** 只在来源所在 Vault 中解析链接；同名笔记无法唯一确定时不猜测目标。 */
export function resolveNoteLink(
  notes: KnowledgeNote[],
  source: KnowledgeNote,
  link: string,
  kind: NoteLinkKind,
): ResolvedNoteLink | null {
  const [rawPath = '', ...fragmentParts] = link.split('#')
  const path = decodeLink(rawPath).trim()
  const fragment = fragmentParts.length ? decodeLink(fragmentParts.join('#')).trim() : null
  if (!path) return fragment ? { note: source, fragment } : null

  const candidates = notes.filter((note) => note.vaultId === source.vaultId)
  const sourceDir = source.filePath.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
  const pathLike = path.includes('/') || path.includes('\\') || /\.(md|html)$/i.test(path)
  const relativePath = normalizePath(`${sourceDir}/${path}`)
  const rootPath = normalizePath(path)
  let paths: Array<string | null>
  if (path.startsWith('/')) {
    paths = [rootPath]
  } else if (kind === 'markdown' || path.startsWith('.')) {
    paths = [relativePath]
  } else {
    paths = [rootPath, relativePath]
  }

  for (const candidatePath of paths) {
    if (!candidatePath) continue
    const direct = uniqueMatch(candidates, (note) => normalizePath(note.filePath) === candidatePath)
    if (direct) return { note: direct, fragment }
    if (!/\.(md|html)$/i.test(candidatePath)) {
      const withoutExtension = uniqueMatch(
        candidates,
        (note) => normalizePath(note.filePath)?.replace(/\.(md|html)$/i, '') === candidatePath,
      )
      if (withoutExtension) return { note: withoutExtension, fragment }
    }
  }

  if (pathLike) return null
  const name = path.toLowerCase()
  const byTitle = uniqueMatch(candidates, (note) => note.title.toLowerCase() === name)
  if (byTitle) return { note: byTitle, fragment }
  const byFileName = uniqueMatch(
    candidates,
    (note) => note.filePath.replaceAll('\\', '/').split('/').pop()?.replace(/\.(md|html)$/i, '').toLowerCase() === name,
  )
  return byFileName ? { note: byFileName, fragment } : null
}
