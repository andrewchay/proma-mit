/** 导出给表格软件时，将可能被解释为公式的文本标为文本；JSON 导出保留原值。 */
export function csvValue(value: unknown): string {
  const raw = value == null ? '' : String(value)
  const formulaLike = typeof value !== 'number' && (/^[\t\r\n]/.test(raw) || /^[\x00-\x20\uFEFF]*[=+\-@]/.test(raw))
  const text = formulaLike ? `'${raw}` : raw
  return `"${text.replaceAll('"', '""')}"`
}
