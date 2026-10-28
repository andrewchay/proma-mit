/** 用户主动下载已授权返回的内容。 */
export function saveDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function exportAuditCsv(request: (path: string) => Promise<Response>, action: string, save: (blob: Blob, filename: string) => void = saveDownload): Promise<void> {
  const query = new URLSearchParams({ format: 'csv' })
  if (action) query.set('action', action)
  const response = await request(`/agent/audit/export?${query}`)
  if (!response.ok) throw new Error(`导出失败：${response.status}`)
  save(await response.blob(), 'audit.csv')
}
