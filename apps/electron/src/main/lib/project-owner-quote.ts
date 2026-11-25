/** 仅当引号排版不同且匹配唯一时，返回成果中的实际逐字片段。 */
export function resolveOwnerTypographyQuote(content: string, quote: string): string | null {
  if (!quote) return null
  const normalize = (value: string) => value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  const source = normalize(content), candidate = normalize(quote), index = source.indexOf(candidate)
  if (index < 0 || source.indexOf(candidate, index + 1) !== -1) return null
  return content.slice(index, index + quote.length)
}

/** 仅移除引用边缘的横向缩进，并保留源码中实际存在的逐字子串。 */
export function resolveOwnerIndentationQuote(quote: string, contains: (candidate: string) => boolean): string | null {
  const trimmed = quote.replace(/^[ \t]+|[ \t]+$/g, '')
  return trimmed && trimmed !== quote && contains(trimmed) ? trimmed : null
}

/** 仅收紧单个已知证据字段的 JSON 分隔空格，保留字段名与值逐字不变。 */
export function readOwnerMetadataQuote(quote: string): { kind: 'path' | 'validation'; exact: string } | null {
  const fields = /^("(?:path|command|validationId|rawOutputSha256)")[ \t]*:[ \t]*("(?:[^"\\\r\n]|\\.)*")$/.exec(quote.trim())
  if (!fields) return null
  return { kind: fields[1] === '"path"' ? 'path' : 'validation', exact: `${fields[1]}:${fields[2]}` }
}

export function ownerSnapshotHasFilePathQuote(files: unknown[], quote: string): boolean {
  return files.some(entry => {
    if (!entry || typeof entry !== 'object' || !('file' in entry) || !('newContent' in entry) || typeof entry.newContent !== 'string') return false
    const file = entry.file
    return file !== null && typeof file === 'object' && 'path' in file && typeof file.path === 'string'
      && quote === `"path":${JSON.stringify(file.path)}`
  })
}
