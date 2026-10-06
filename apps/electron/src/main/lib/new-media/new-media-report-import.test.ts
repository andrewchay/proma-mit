import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import {
  NEW_MEDIA_IMPORT_CONTRACTS,
  getNewMediaImportContract,
  isCommercialSource,
  mapImportHeaders,
  normalizeImportHeader,
} from './new-media-import-contract'
import {
  commitNewMediaImport,
  listNewMediaImportBatches,
  listNewMediaImportedRows,
  parseCsvText,
  parseImportDate,
  parseImportFile,
  previewNewMediaImport,
} from './new-media-report-import'
import { listNewMediaAudit } from './new-media-audit'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from './new-media-sqlite-store'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-import-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await clearNewMediaRecordsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

const encoder = new TextEncoder()
function csvParsed(name: string, content: string) {
  return parseImportFile({ fileName: name, bytes: encoder.encode(content) })
}

const PROFESSIONAL_CSV = [
  '日期,笔记标题,笔记ID,曝光量,阅读量,点赞数,收藏数,评论数,分享数,涨粉数',
  '2026-09-01,秋季新品测评,note-1,"12,000",3000,120,45,18,6,12',
  '2026-09-02,秋季新品测评,note-1,15000,3600,150,52,21,7,15',
].join('\n')

const PUGONGYING_CSV = [
  '日期,笔记标题,笔记ID,合作品牌,曝光量,阅读量,互动量,消耗,转化数,涨粉数',
  '2026-09-01,联名体验,note-9,某品牌,80000,9000,1200,4500,30,60',
].join('\n')

const JUGUANG_CSV = [
  '广告计划,日期,消耗,曝光量,点击量,互动量,转化数',
  '计划A,2026-09-01,3200,120000,4800,900,42',
].join('\n')

/** 生成最小可解析的 XLSX，用于验证结构化解析与行号血缘。 */
function buildXlsx(headers: string[], rows: Array<Array<string | number>>): Uint8Array {
  const zip = new AdmZip()
  const shared: string[] = []
  const sharedIndex = (value: string): number => {
    const existing = shared.indexOf(value)
    if (existing >= 0) return existing
    shared.push(value)
    return shared.length - 1
  }
  const columnName = (index: number): string => String.fromCharCode(65 + index)
  const headerCells = headers.map((value, index) => `<c r="${columnName(index)}1" t="s"><v>${sharedIndex(value)}</v></c>`).join('')
  const bodyRows = rows.map((cells, rowIndex) => {
    const r = rowIndex + 2
    return `<row r="${r}">${cells.map((cell, index) => {
      const ref = `${columnName(index)}${r}`
      return typeof cell === 'number' ? `<c r="${ref}"><v>${cell}</v></c>` : `<c r="${ref}" t="s"><v>${sharedIndex(String(cell))}</v></c>`
    }).join('')}</row>`
  }).join('')
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`))
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`))
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>`))
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`))
  zip.addFile('xl/sharedStrings.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`))
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1">${headerCells}</row>${bodyRows}
</sheetData></worksheet>`))
  return new Uint8Array(zip.toBuffer())
}

describe('P1-06 报表导入契约', () => {
  test('三类来源分别声明口径与商业边界', () => {
    expect(NEW_MEDIA_IMPORT_CONTRACTS.map((item) => item.sourceKind)).toEqual([
      'xiaohongshu-professional', 'xiaohongshu-pugongying', 'xiaohongshu-juguang',
    ])
    const professional = getNewMediaImportContract('xiaohongshu-professional')
    expect(professional.commercial).toBe(false)
    expect(professional.boundary).toContain('自有内容')
    for (const kind of ['xiaohongshu-pugongying', 'xiaohongshu-juguang'] as const) {
      const contract = getNewMediaImportContract(kind)
      expect(contract.commercial).toBe(true)
      expect(contract.requiresCommercialAuthorization).toBe(true)
      expect(contract.boundary).toContain('不能代表账号整体')
      expect(isCommercialSource(kind)).toBe(true)
      // 每一列都必须有可达的口径说明
      expect(contract.columns.every((column) => column.definition.length > 8)).toBe(true)
    }
    expect(() => getNewMediaImportContract('weibo' as never)).toThrow('不支持的报表来源')
  })

  test('表头别名归一化后可映射，缺少必要列时报错', () => {
    expect(normalizeImportHeader(' 曝光量 (次) ')).toBe('曝光量')
    const mapped = mapImportHeaders('xiaohongshu-professional', ['数据日期', '笔记标题', '曝光量（次）', '点赞数'])
    expect(mapped.mapping.date).toBe(0)
    expect(mapped.mapping.impressions).toBe(2)
    expect(mapped.missingRequired).toEqual([])

    const missing = mapImportHeaders('xiaohongshu-professional', ['笔记标题', '曝光量'])
    expect(missing.missingRequired).toEqual(['date'])
  })
})

describe('P1-07 CSV/XLSX 导入与预览', () => {
  test('CSV 解析支持引号内逗号、BOM 与 CRLF', () => {
    const table = parseCsvText('\uFEFF日期,曝光量\r\n2026-09-01,"12,000"\r\n')
    expect(table.headers).toEqual(['日期', '曝光量'])
    expect(table.rows).toEqual([{ rowNumber: 2, cells: ['2026-09-01', '12,000'] }])
  })

  test('日期解析支持多种书写与 Excel 序列号，拒绝越界数值', () => {
    expect(parseImportDate('2026-09-01')?.dayKey).toBe('2026-09-01')
    expect(parseImportDate('2026/9/1')?.dayKey).toBe('2026-09-01')
    expect(parseImportDate('2026年9月1日')?.dayKey).toBe('2026-09-01')
    expect(parseImportDate('46266')?.dayKey).toBe('2026-09-01')
    expect(parseImportDate('1234')).toBeUndefined()
    expect(parseImportDate('')).toBeUndefined()
  })

  test('预览不入库，并逐行给出非法原因', async () => {
    const parsed = await csvParsed('专业号.csv', [
      '日期,笔记标题,曝光量,点赞数',
      '2026-09-01,正常笔记,1200,30',
      ',缺日期,900,10',
      '2026-09-02,数值错误,abc,10',
      '2026-09-03,没有指标,,',
    ].join('\n'))
    const preview = await previewNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed })

    expect(preview.totalRows).toBe(4)
    expect(preview.validRows).toBe(1)
    expect(preview.invalidRows.map((row) => row.rowNumber)).toEqual([3, 4, 5])
    expect(preview.invalidRows[0]?.reason).toContain('日期缺失')
    expect(preview.commercial).toBe(false)
    expect(preview.boundary).toContain('自有内容')
    // 预览阶段不能写库
    expect(await listNewMediaImportBatches()).toEqual([])
    expect(await listNewMediaImportedRows()).toEqual([])
  })

  test('缺少必要列直接拒绝，未确认不得提交', async () => {
    const bad = await csvParsed('无日期.csv', '笔记标题,曝光量\n笔记A,100\n')
    await expect(previewNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed: bad })).rejects.toThrow('缺少必要列：日期')

    const good = await csvParsed('专业号.csv', PROFESSIONAL_CSV)
    await expect(commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed: good, importedBy: 'Carol', confirmed: false })).rejects.toThrow('必须先核对预览并确认')

    expect(await listNewMediaImportBatches()).toEqual([])
  })

  test('不支持的扩展名与空文件被拒绝', async () => {
    await expect(parseImportFile({ fileName: '报表.pdf', bytes: encoder.encode('x') })).rejects.toThrow('不支持的导入文件类型')
    await expect(parseImportFile({ fileName: '报表.csv', bytes: new Uint8Array() })).rejects.toThrow('导入文件为空')
  })

  test('XLSX 结构化解析保留原始行号与工作表名', async () => {
    const bytes = buildXlsx(['日期', '笔记标题', '曝光量', '点赞数'], [
      ['2026-09-01', '表格笔记', 1200, 30],
      ['2026-09-02', '表格笔记', 1500, 41],
    ])
    const parsed = await parseImportFile({ fileName: '专业号.xlsx', bytes })
    expect(parsed.table.sheetName).toBe('数据')
    expect(parsed.table.headers).toEqual(['日期', '笔记标题', '曝光量', '点赞数'])
    expect(parsed.table.rows.map((row) => row.rowNumber)).toEqual([2, 3])

    const preview = await previewNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed })
    expect(preview.validRows).toBe(2)
    expect(preview.previewRows[0]?.metrics.impressions).toBe(1200)
  })
})

describe('P1-08 去重、幂等与数据血缘', () => {
  test('提交后可按批次追溯血缘，商业与账号来源分开保存', async () => {
    const professional = await csvParsed('专业号.csv', PROFESSIONAL_CSV)
    const batch = await commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed: professional, importedBy: 'Carol', confirmed: true })
    expect(batch.importedRows).toBe(2)
    expect(batch.commercial).toBe(false)

    const rows = await listNewMediaImportedRows(batch.id)
    expect(rows.map((row) => row.rowNumber)).toEqual([2, 3])
    expect(rows.every((row) => row.batchId === batch.id)).toBe(true)
    expect(rows[0]?.metrics.impressions).toBe(12000)
    expect(rows.every((row) => row.rowHash.length === 64)).toBe(true)

    const pugongying = await csvParsed('蒲公英.csv', PUGONGYING_CSV)
    const commercialBatch = await commitNewMediaImport({ sourceKind: 'xiaohongshu-pugongying', accountId: 'acc-1', parsed: pugongying, importedBy: 'Carol', confirmed: true })
    expect(commercialBatch.commercial).toBe(true)
    const commercialRows = await listNewMediaImportedRows(commercialBatch.id)
    expect(commercialRows[0]?.metrics.spend).toBe(4500)

    const batches = await listNewMediaImportBatches()
    expect(batches.map((item) => item.commercial).sort()).toEqual([false, true])
  })

  test('同一文件重复导入被拒绝，明确确认后不重复计数', async () => {
    const parsed = await csvParsed('专业号.csv', PROFESSIONAL_CSV)
    const first = await commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed, importedBy: 'Carol', confirmed: true })

    await expect(commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed, importedBy: 'Carol', confirmed: true })).rejects.toThrow('已导入过')

    const replay = await commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed, importedBy: 'Carol', confirmed: true, allowDuplicateFile: true })
    expect(replay.duplicateOfBatchId).toBe(first.id)
    expect(replay.importedRows).toBe(0)
    expect(replay.skippedDuplicateRows).toBe(2)
    expect((await listNewMediaImportedRows()).length).toBe(2)
  })

  test('跨批次重复行同样去重，不同账号互不影响', async () => {
    const parsed = await csvParsed('专业号.csv', PROFESSIONAL_CSV)
    await commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed, importedBy: 'Carol', confirmed: true })

    // 内容相同的另一份文件（行内容一致，但文件哈希不同）
    const shifted = await csvParsed('专业号-副本.csv', `${PROFESSIONAL_CSV}\n`)
    const second = await commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed: shifted, importedBy: 'Carol', confirmed: true })
    expect(second.importedRows).toBe(0)
    expect(second.skippedDuplicateRows).toBe(2)

    const otherAccount = await csvParsed('专业号.csv', PROFESSIONAL_CSV)
    const third = await commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-2', parsed: otherAccount, importedBy: 'Carol', confirmed: true })
    expect(third.importedRows).toBe(2)
    expect((await listNewMediaImportedRows()).length).toBe(4)
  })

  test('导入写入统一审计，不包含行内容明文', async () => {
    const juguang = await csvParsed('聚光.csv', JUGUANG_CSV)
    const batch = await commitNewMediaImport({ sourceKind: 'xiaohongshu-juguang', accountId: 'acc-1', parsed: juguang, importedBy: 'Carol', confirmed: true })
    const audits = await listNewMediaAudit({ domain: 'import' })
    expect(audits).toHaveLength(1)
    expect(audits[0]?.subjectId).toBe(batch.id)
    expect(audits[0]?.detail).toContain('聚光.csv')
    expect(JSON.stringify(audits)).not.toContain('计划A')
  })
})
