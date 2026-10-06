/**
 * 小红书报表导入：解析 → 预览 → 用户确认 → 入库。
 *
 * 设计约束：
 * - 解析阶段不写库，预览结果必须由用户确认后才能提交。
 * - 不合法行不入库，逐行给出可读原因。
 * - 批次保存原文件 SHA-256 与逐行哈希，重复导入不重复计数。
 * - 每行保留批次、原始行号与来源，形成可追溯血缘。
 * - 商业来源（蒲公英/聚光）与账号来源分开存储与展示。
 */
import { createHash, randomUUID } from 'node:crypto'
import type {
  NewMediaImportInvalidRow,
  NewMediaImportPreview,
  NewMediaImportPreviewRow,
  NewMediaImportSourceKind,
  NewMediaImportedReportRow,
  NewMediaPlatform,
  NewMediaReportImportBatch,
} from '@gravitas/shared'
import { NEW_MEDIA_AUDIT_KIND, createNewMediaAuditEntry } from './new-media-audit'
import { getNewMediaImportContract, importColumnKind, isCommercialSource, mapImportHeaders } from './new-media-import-contract'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecords } from './new-media-sqlite-store'

export const IMPORT_BATCH_KIND = 'report-import-batch'
export const IMPORTED_ROW_KIND = 'report-import-row'

export type { NewMediaImportPreview, NewMediaReportImportBatch, NewMediaImportedReportRow }

/** 可解析的原始表格：首行为表头。 */
export interface RawTable {
  sheetName?: string
  headers: string[]
  rows: Array<{ rowNumber: number; cells: string[] }>
}

const MAX_ROWS = 5000
const MAX_FILE_BYTES = 8 * 1024 * 1024

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Mini RFC4180 CSV 解析：支持引号包裹、转义引号、CRLF，忽略完全空白行。
 * 不使用第三方依赖，便于对异常文件保持确定行为。
 */
export function parseCsvText(text: string): RawTable {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: Array<{ rowNumber: number; cells: string[] }> = []
  let cells: string[] = []
  let current = ''
  let inQuotes = false
  let lineNumber = 1

  const pushCell = (): void => {
    cells.push(current.trim())
    current = ''
  }
  const pushRow = (): void => {
    pushCell()
    const hasContent = cells.some((cell) => cell !== '')
    if (hasContent) rows.push({ rowNumber: lineNumber, cells })
    cells = []
  }

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') { current += '"'; index += 1 }
        else inQuotes = false
      } else {
        if (char === '\n') lineNumber += 1
        current += char
      }
      continue
    }
    if (char === '"') { inQuotes = true; continue }
    if (char === ',') { pushCell(); continue }
    if (char === '\r') continue
    if (char === '\n') { pushRow(); lineNumber += 1; continue }
    current += char
  }
  pushRow()

  const [header, ...body] = rows
  if (!header) throw new Error('文件中没有可解析的表格内容')
  return { headers: header.cells, rows: body }
}

async function parseXlsx(buffer: Uint8Array): Promise<RawTable> {
  const { default: readXlsxFile } = await import('read-excel-file/node')
  let sheets: Array<{ sheet: string; data: Array<Array<unknown>> }>
  try {
    sheets = await readXlsxFile(Buffer.from(buffer)) as unknown as Array<{ sheet: string; data: Array<Array<unknown>> }>
  } catch (error) {
    throw new Error(`XLSX 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('文件中没有可解析的工作表')
  // 优先使用首个含数据的工作表；多工作表文件在预览中显示实际选用的表名。
  const target = sheets.find((item) => toRows(item.data).length > 0) ?? sheets[0]
  if (!target) throw new Error('文件中没有可解析的工作表')
  const rows = toRows(target.data)
  const [header, ...body] = rows
  if (!header) throw new Error('文件中没有可解析的表格内容')
  return {
    sheetName: target.sheet,
    headers: header.cells,
    rows: body,
  }
}

function toRows(data: Array<Array<unknown>>): Array<{ rowNumber: number; cells: string[] }> {
  return data
    .map((cells, position) => ({
      // +1：转 1-based 行号，与用户在表格软件里看到的行号一致。
      rowNumber: position + 1,
      cells: (cells ?? []).map((cell) => formatCell(cell)),
    }))
    .filter((row) => row.cells.some((cell) => cell !== ''))
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value).trim()
}

/** 日期解析：接受 yyyy-mm-dd、yyyy/mm/dd、yyyy年m月d日，以及 Excel 序列号（仅当落在合理区间）。 */
export function parseImportDate(raw: string): { timestamp: number; dayKey: string } | undefined {
  const value = raw.trim()
  if (!value) return undefined
  const normalized = value.replace(/[年月]/g, '-').replace(/日/g, '')
  const direct = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(normalized)
  if (direct) {
    const [, year, month, day] = direct
    const monthNumber = Number(month)
    const dayNumber = Number(day)
    // 显式校验范围：JS Date 会把 13 月或 99 日静默进位到别的日期，必须自己拒绝。
    if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return undefined
    const date = new Date(Number(year), monthNumber - 1, dayNumber)
    if (Number.isNaN(date.getTime())) return undefined
    if (date.getFullYear() !== Number(year) || date.getMonth() !== monthNumber - 1 || date.getDate() !== dayNumber) return undefined
    return { timestamp: date.getTime(), dayKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` }
  }
  if (/^\d{5}(\.\d+)?$/.test(value)) {
    const serial = Number(value)
    // Excel 序列号起点 1899-12-30，仅接受 2000-01-01 到 2100-01-01 之间的取值，避免把数值误判为日期。
    if (serial < 36526 || serial > 73415) return undefined
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000)
    const dayKey = date.toISOString().slice(0, 10)
    return { timestamp: Date.parse(`${dayKey}T00:00:00Z`), dayKey }
  }
  return undefined
}

function parseMetricValue(raw: string, kind: string): number | undefined {
  const value = raw.replace(/[,\s¥￥$元%]/g, '').trim()
  if (!value || value === '-') return undefined
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  if (kind === 'ratio') return numeric > 1 ? Number((numeric / 100).toFixed(6)) : numeric
  return numeric
}

export interface ParsedImportFile {
  table: RawTable
  fileName: string
  fileSha256: string
}

/** 解析导入文件；支持 .csv 与 .xlsx，其它扩展名直接拒绝。 */
export async function parseImportFile(input: { fileName: string; bytes: Uint8Array }): Promise<ParsedImportFile> {
  if (input.bytes.byteLength === 0) throw new Error('导入文件为空')
  if (input.bytes.byteLength > MAX_FILE_BYTES) throw new Error(`导入文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024}MB`)
  const extension = input.fileName.toLowerCase().replace(/^.*\./, '')
  const fileSha256 = sha256(input.bytes)
  if (extension === 'csv' || extension === 'txt') {
    return { table: parseCsvText(decodeText(input.bytes)), fileName: input.fileName, fileSha256 }
  }
  if (extension === 'xlsx' || extension === 'xlsm') {
    return { table: await parseXlsx(input.bytes), fileName: input.fileName, fileSha256 }
  }
  throw new Error(`不支持的导入文件类型：.${extension}（仅支持 .csv 与 .xlsx）`)
}

/**
 * 文本解码：优先 UTF-8（自动处理 BOM），失败时回退 GBK，
 * 因为国内后台导出的 CSV 常见 GBK 编码。
 */
function decodeText(bytes: Uint8Array): string {
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return utf8
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}

interface EvaluatedRow {
  rowNumber: number
  dayKey: string
  timestamp: number
  contentId?: string
  contentTitle?: string
  brand?: string
  planName?: string
  metrics: Record<string, number>
}

/**
 * 逐行求值：预览与提交共用同一实现，避免两条路径对「合法行」的判断出现分歧。
 */
function evaluateImportRows(input: {
  sourceKind: NewMediaImportSourceKind
  table: RawTable
  mapping: Record<string, number>
}): { rows: EvaluatedRow[]; invalidRows: NewMediaImportInvalidRow[] } {
  const metricFields = Object.keys(input.mapping).filter((field) => ['count', 'currency', 'ratio'].includes(importColumnKind(input.sourceKind, field) ?? ''))
  const dateColumn = input.mapping.date
  if (dateColumn === undefined) throw new Error('缺少日期列映射')
  const rows: EvaluatedRow[] = []
  const invalidRows: NewMediaImportInvalidRow[] = []
  for (const row of input.table.rows) {
    const dateValue = parseImportDate(row.cells[dateColumn] ?? '')
    if (!dateValue) {
      invalidRows.push({ rowNumber: row.rowNumber, reason: `日期缺失或无法识别：${row.cells[dateColumn] ?? '（空）'}` })
      continue
    }
    const metrics: Record<string, number> = {}
    let invalidReason: string | undefined
    for (const field of metricFields) {
      const column = input.mapping[field]
      if (column === undefined) continue
      const raw = row.cells[column] ?? ''
      if (raw.trim() === '') continue
      const parsed = parseMetricValue(raw, importColumnKind(input.sourceKind, field) ?? 'count')
      if (parsed === undefined) { invalidReason = `${field} 不是合法数字：${raw}`; break }
      if (parsed < 0) { invalidReason = `${field} 不能为负数：${raw}`; break }
      metrics[field] = parsed
    }
    if (invalidReason) { invalidRows.push({ rowNumber: row.rowNumber, reason: invalidReason }); continue }
    if (Object.keys(metrics).length === 0) { invalidRows.push({ rowNumber: row.rowNumber, reason: '该行没有任何可用指标值' }); continue }
    rows.push({
      rowNumber: row.rowNumber,
      dayKey: dateValue.dayKey,
      timestamp: dateValue.timestamp,
      contentId: input.mapping.contentId !== undefined ? row.cells[input.mapping.contentId] || undefined : undefined,
      contentTitle: input.mapping.contentTitle !== undefined ? row.cells[input.mapping.contentTitle] || undefined : undefined,
      brand: input.mapping.brand !== undefined ? row.cells[input.mapping.brand] || undefined : undefined,
      planName: input.mapping.planName !== undefined ? row.cells[input.mapping.planName] || undefined : undefined,
      metrics,
    })
  }
  return { rows, invalidRows }
}

export interface PreviewImportInput {
  sourceKind: NewMediaImportSourceKind
  accountId: string
  parsed: ParsedImportFile
  /** 预览凭据由 IPC 层注入，领域函数本身不关心它的来源。 */
  pendingToken?: string
}

/** 生成导入预览：不写库，仅供用户核对列映射与逐行问题。 */
export async function previewNewMediaImport(input: PreviewImportInput): Promise<NewMediaImportPreview> {
  const { table, fileName, fileSha256 } = input.parsed
  const contract = getNewMediaImportContract(input.sourceKind)
  if (input.accountId.trim() === '') throw new Error('必须指定导入归属账号')
  if (table.rows.length === 0) throw new Error('文件中没有数据行')
  if (table.rows.length > MAX_ROWS) throw new Error(`单次导入不能超过 ${MAX_ROWS} 行`)

  const { mapping, matchedFields, missingRequired, unmappedHeaders } = mapImportHeaders(input.sourceKind, table.headers)
  if (missingRequired.length > 0) {
    const labels = missingRequired.map((field) => contract.columns.find((column) => column.field === field)?.label ?? field)
    throw new Error(`缺少必要列：${labels.join('、')}`)
  }
  const metricFields = Object.keys(mapping).filter((field) => ['count', 'currency', 'ratio'].includes(importColumnKind(input.sourceKind, field) ?? ''))
  if (metricFields.length === 0) throw new Error('未识别到任何可导入的指标列，请核对表头')

  const existing = (await listNewMediaRecords<NewMediaReportImportBatch>(IMPORT_BATCH_KIND))
    .find((batch) => batch.fileSha256 === fileSha256 && batch.sourceKind === input.sourceKind && batch.accountId === input.accountId)

  const evaluated = evaluateImportRows({ sourceKind: input.sourceKind, table, mapping })
  const previewRows: NewMediaImportPreview['previewRows'] = evaluated.rows.slice(0, 20).map((row) => ({
    rowNumber: row.rowNumber,
    date: row.dayKey,
    contentTitle: row.contentTitle,
    metrics: row.metrics,
  }))

  return {
    sourceKind: input.sourceKind,
    fileName,
    fileSha256,
    sheetName: table.sheetName,
    headers: table.headers,
    mapping,
    matchedFields,
    missingRequired,
    unmappedHeaders,
    totalRows: table.rows.length,
    validRows: evaluated.rows.length,
    invalidRows: evaluated.invalidRows,
    existingBatchId: existing?.id,
    pendingToken: input.pendingToken ?? '',
    previewRows,
    boundary: contract.boundary,
    commercial: isCommercialSource(input.sourceKind),
  }
}

export interface CommitImportInput {
  sourceKind: NewMediaImportSourceKind
  accountId: string
  parsed: ParsedImportFile
  importedBy: string
  /** 用户已在预览中确认列映射与逐行问题。 */
  confirmed: boolean
  /** 明确允许重复导入同一文件（默认拒绝）。 */
  allowDuplicateFile?: boolean
}

function rowHashOf(sourceKind: NewMediaImportSourceKind, accountId: string, dayKey: string, row: NewMediaImportedReportRow): string {
  const stable = JSON.stringify({
    sourceKind,
    accountId,
    dayKey,
    contentId: row.contentId ?? '',
    contentTitle: row.contentTitle ?? '',
    brand: row.brand ?? '',
    planName: row.planName ?? '',
    metrics: Object.fromEntries(Object.entries(row.metrics).sort(([left], [right]) => left.localeCompare(right))),
  })
  return sha256(stable)
}

/** 提交导入：不合法行不入库，重复行不重复计数，并保留批次血缘。 */
export async function commitNewMediaImport(input: CommitImportInput): Promise<NewMediaReportImportBatch> {
  if (!input.confirmed) throw new Error('必须先核对预览并确认，才能写入导入数据')
  const preview = await previewNewMediaImport({ sourceKind: input.sourceKind, accountId: input.accountId, parsed: input.parsed })
  if (preview.existingBatchId && !input.allowDuplicateFile) {
    throw new Error(`同名同内容的文件已导入过（批次 ${preview.existingBatchId}）；如需再次导入请明确确认`)
  }

  const { table, fileName, fileSha256 } = input.parsed
  const platform: NewMediaPlatform = 'xiaohongshu'
  const accountId = input.accountId.trim()
  const existingRows = await listNewMediaRecords<NewMediaImportedReportRow>(IMPORTED_ROW_KIND)
  const knownHashes = new Set(existingRows.map((row) => row.rowHash))

  const evaluated = evaluateImportRows({ sourceKind: input.sourceKind, table, mapping: preview.mapping })
  const invalidRows = evaluated.invalidRows
  const batchId = randomUUID()
  const createdAt = Date.now()
  const newRows: NewMediaImportedReportRow[] = []
  let skippedDuplicateRows = 0
  const batchHashes = new Set<string>()

  for (const row of evaluated.rows) {
    const candidate: NewMediaImportedReportRow = {
      id: randomUUID(),
      batchId,
      sourceKind: input.sourceKind,
      commercial: preview.commercial,
      platform,
      accountId,
      capturedAt: row.timestamp,
      contentId: row.contentId,
      contentTitle: row.contentTitle,
      brand: row.brand,
      planName: row.planName,
      metrics: row.metrics,
      rowNumber: row.rowNumber,
      rowHash: '',
      createdAt,
    }
    candidate.rowHash = rowHashOf(input.sourceKind, accountId, row.dayKey, candidate)
    if (knownHashes.has(candidate.rowHash) || batchHashes.has(candidate.rowHash)) {
      skippedDuplicateRows += 1
      continue
    }
    batchHashes.add(candidate.rowHash)
    newRows.push(candidate)
  }

  if (newRows.length === 0 && invalidRows.length === table.rows.length) throw new Error('文件中没有可导入的合法行，请核对列映射与数值格式')

  const batch: NewMediaReportImportBatch = {
    id: batchId,
    sourceKind: input.sourceKind,
    platform,
    accountId,
    fileName,
    fileSha256,
    totalRows: table.rows.length,
    importedRows: newRows.length,
    skippedDuplicateRows,
    invalidRows,
    mapping: preview.mapping,
    commercial: preview.commercial,
    importedAt: createdAt,
    importedBy: input.importedBy.trim() || 'local-user',
    duplicateOfBatchId: preview.existingBatchId,
  }

  // 批次与行在同一事务写入，避免出现没有血缘的孤立指标。
  await putNewMediaRecords([
    { kind: IMPORT_BATCH_KIND, value: batch },
    ...newRows.map((row) => ({ kind: IMPORTED_ROW_KIND, value: row })),
    {
      kind: NEW_MEDIA_AUDIT_KIND,
      value: await createNewMediaAuditEntry({
        domain: 'import',
        event: 'report_batch_imported',
        actor: batch.importedBy,
        subjectId: batchId,
        detail: `已导入报表 ${fileName}：写入 ${newRows.length} 行，跳过重复 ${skippedDuplicateRows} 行，拒绝非法 ${invalidRows.length} 行。`,
        metadata: { sourceKind: batch.sourceKind, commercial: batch.commercial, importedRows: newRows.length, skippedDuplicateRows, invalidRows: invalidRows.length },
      }),
    },
  ])
  return batch
}

export async function listNewMediaImportBatches(): Promise<NewMediaReportImportBatch[]> {
  return listNewMediaRecords<NewMediaReportImportBatch>(IMPORT_BATCH_KIND)
}

export async function getNewMediaImportBatch(batchId: string): Promise<NewMediaReportImportBatch | undefined> {
  return getNewMediaRecord<NewMediaReportImportBatch>(IMPORT_BATCH_KIND, batchId)
}

export async function listNewMediaImportedRows(batchId?: string): Promise<NewMediaImportedReportRow[]> {
  const rows = await listNewMediaRecords<NewMediaImportedReportRow>(IMPORTED_ROW_KIND)
  const scoped = batchId ? rows.filter((row) => row.batchId === batchId) : rows
  // 同一批次的行写入时间可能相同，必须按原始行号兜底，保证顺序稳定可复现。
  return scoped.sort((left, right) => left.createdAt - right.createdAt || left.batchId.localeCompare(right.batchId) || left.rowNumber - right.rowNumber)
}
