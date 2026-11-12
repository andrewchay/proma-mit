/** 仅当引号排版不同且匹配唯一时，返回成果中的实际逐字片段。 */
export function resolveOwnerTypographyQuote(content: string, quote: string): string | null {
  if (!quote) return null
  const normalize = (value: string) => value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  const source = normalize(content), candidate = normalize(quote), index = source.indexOf(candidate)
  if (index < 0 || source.indexOf(candidate, index + 1) !== -1) return null
  return content.slice(index, index + quote.length)
}
