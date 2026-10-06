/**
 * 小红书报表导入契约。
 *
 * 三类数据来源的能力边界不同，必须在契约层就分开声明，避免把商业投放数据
 * 混同为账号整体经营数据：
 *
 * - `xiaohongshu-professional`：专业号后台导出的自有账号笔记数据（账号口径）。
 * - `xiaohongshu-pugongying`：蒲公英合作笔记与投后数据（仅限已授权合作范围）。
 * - `xiaohongshu-juguang`：聚光广告投放数据（仅广告计划范围，需白名单）。
 *
 * 契约只描述「文件里有哪些列、每列是什么口径」，不做任何平台网络请求，
 * 也不推断未在文件中出现的指标。
 */

import type {
  NewMediaImportColumn,
  NewMediaImportContract,
  NewMediaImportMetricKind,
  NewMediaImportSourceKind,
} from '@gravitas/shared'

export type { NewMediaImportColumn, NewMediaImportContract, NewMediaImportMetricKind, NewMediaImportSourceKind }

const SHARED_DATE_COLUMNS: readonly NewMediaImportColumn[] = [
  {
    field: 'date',
    label: '日期',
    kind: 'date',
    definition: '数据所属自然日，按导出文件时区解释；用于确定指标的时间归属。',
    required: true,
    aliases: ['日期', '数据日期', '统计日期', 'date', '日期(yyyy-mm-dd)'],
  },
]

const ACCOUNT_CONTENT_COLUMNS: readonly NewMediaImportColumn[] = [
  {
    field: 'contentId',
    label: '笔记标识',
    kind: 'text',
    definition: '平台侧笔记唯一标识；缺失时按标题+日期匹配，不保证跨批次稳定。',
    required: false,
    aliases: ['笔记id', '笔记编号', '内容id', 'note_id', '笔记标识'],
  },
  {
    field: 'contentTitle',
    label: '笔记标题',
    kind: 'text',
    definition: '笔记标题原文，仅用于人工核对，不参与指标汇总。',
    required: false,
    aliases: ['笔记标题', '标题', '内容标题', 'note_title'],
  },
]

const ACCOUNT_METRIC_COLUMNS: readonly NewMediaImportColumn[] = [
  {
    field: 'impressions',
    label: '曝光量',
    kind: 'count',
    definition: '笔记被展示次数，账号口径；不等于阅读人数。',
    required: false,
    aliases: ['曝光量', '曝光数', '展现量', 'impressions'],
  },
  {
    field: 'reads',
    label: '阅读量',
    kind: 'count',
    definition: '笔记详情被打开次数，账号口径。',
    required: false,
    aliases: ['阅读量', '阅读数', '观看量', '播放量', 'reads'],
  },
  {
    field: 'likes',
    label: '点赞数',
    kind: 'count',
    definition: '笔记获得点赞次数增量。',
    required: false,
    aliases: ['点赞数', '点赞量', '赞', 'likes'],
  },
  {
    field: 'collects',
    label: '收藏数',
    kind: 'count',
    definition: '笔记被收藏次数增量。',
    required: false,
    aliases: ['收藏数', '收藏量', 'collects'],
  },
  {
    field: 'comments',
    label: '评论数',
    kind: 'count',
    definition: '笔记收到评论数增量，不包含回复。',
    required: false,
    aliases: ['评论数', '评论量', 'comments'],
  },
  {
    field: 'shares',
    label: '分享数',
    kind: 'count',
    definition: '笔记被分享次数增量。',
    required: false,
    aliases: ['分享数', '分享量', '转发数', 'shares'],
  },
  {
    field: 'followersGained',
    label: '新增粉丝',
    kind: 'count',
    definition: '当日新增关注数，账号口径；可能与取消关注相抵前的口径不同。',
    required: false,
    aliases: ['涨粉数', '新增粉丝', '新增关注', '关注数', 'followers_gained'],
  },
]

const COMMERCIAL_METRIC_COLUMNS: readonly NewMediaImportColumn[] = [
  {
    field: 'spend',
    label: '消耗金额',
    kind: 'currency',
    definition: '广告或合作产生的实际消耗金额，币种以平台后台为准。',
    required: false,
    aliases: ['消耗', '消耗金额', '花费', '投放花费', 'spend'],
  },
  {
    field: 'impressions',
    label: '曝光量',
    kind: 'count',
    definition: '广告或合作内容的展示次数，仅覆盖投放范围，不代表账号整体曝光。',
    required: false,
    aliases: ['曝光量', '曝光数', '展现量', 'impressions'],
  },
  {
    field: 'clicks',
    label: '点击量',
    kind: 'count',
    definition: '广告或合作内容被点击次数，仅覆盖投放范围。',
    required: false,
    aliases: ['点击量', '点击次数', 'clicks'],
  },
  {
    field: 'interactions',
    label: '互动量',
    kind: 'count',
    definition: '平台口径的互动总数；不同报表对互动的构成定义可能不同，不与其他来源相加。',
    required: false,
    aliases: ['互动量', '互动数', 'interactions'],
  },
  {
    field: 'conversions',
    label: '转化数',
    kind: 'count',
    definition: '平台判定的转化次数；判定口径由平台定义，本地不做归因推断。',
    required: false,
    aliases: ['转化数', '转化量', 'conversions'],
  },
]

export const NEW_MEDIA_IMPORT_CONTRACTS: readonly NewMediaImportContract[] = [
  {
    sourceKind: 'xiaohongshu-professional',
    label: '小红书专业号后台报表',
    origin: '小红书专业号后台「数据中心」导出的笔记数据文件',
    commercial: false,
    requiresCommercialAuthorization: false,
    boundary: '只覆盖被导出账号的自有内容，可代表账号整体表现。',
    columns: [...SHARED_DATE_COLUMNS, ...ACCOUNT_CONTENT_COLUMNS, ...ACCOUNT_METRIC_COLUMNS],
  },
  {
    sourceKind: 'xiaohongshu-pugongying',
    label: '蒲公英合作与投后数据',
    origin: '小红书蒲公英后台导出的合作笔记与投后数据文件',
    commercial: true,
    requiresCommercialAuthorization: true,
    boundary: '只覆盖已授权合作笔记，不能代表账号整体表现，也不能外推到其他博主或其他笔记。',
    columns: [
      ...SHARED_DATE_COLUMNS,
      ...ACCOUNT_CONTENT_COLUMNS,
      {
        field: 'brand',
        label: '合作品牌',
        kind: 'text',
        definition: '该合作对应的品牌，仅用于区分合作范围。',
        required: false,
        aliases: ['品牌', '合作品牌', 'brand'],
      },
      ...ACCOUNT_METRIC_COLUMNS.filter((column) => ['impressions', 'reads', 'followersGained'].includes(column.field)),
      ...COMMERCIAL_METRIC_COLUMNS.filter((column) => ['spend', 'interactions', 'conversions'].includes(column.field)),
    ],
  },
  {
    sourceKind: 'xiaohongshu-juguang',
    label: '聚光广告投放数据',
    origin: '小红书聚光平台导出的广告计划报表文件',
    commercial: true,
    requiresCommercialAuthorization: true,
    boundary: '只覆盖投放中的广告计划，与笔记自然流量严格分离，不能代表账号整体表现；白名单到期后不得继续导入。',
    columns: [
      ...SHARED_DATE_COLUMNS,
      {
        field: 'planName',
        label: '广告计划',
        kind: 'text',
        definition: '聚光广告计划名称，用于区分投放范围。',
        required: false,
        aliases: ['广告计划', '计划名称', '计划', 'plan'],
      },
      ...COMMERCIAL_METRIC_COLUMNS,
    ],
  },
]

export function getNewMediaImportContract(sourceKind: NewMediaImportSourceKind): NewMediaImportContract {
  const contract = NEW_MEDIA_IMPORT_CONTRACTS.find((item) => item.sourceKind === sourceKind)
  if (!contract) throw new Error(`不支持的报表来源：${String(sourceKind)}`)
  return contract
}

export function isNewMediaImportSourceKind(value: unknown): value is NewMediaImportSourceKind {
  return NEW_MEDIA_IMPORT_CONTRACTS.some((contract) => contract.sourceKind === value)
}

/** 表头归一化：去空白、去全角空格、去常见单位后缀后小写比较。 */
export function normalizeImportHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .toLowerCase()
}

/**
 * 将表头映射到契约字段。
 * 返回每个字段命中的列索引；同一列被多个字段命中时按契约顺序先到先得。
 */
export function mapImportHeaders(sourceKind: NewMediaImportSourceKind, headers: readonly string[]): {
  mapping: Record<string, number>
  matchedFields: string[]
  missingRequired: string[]
  unmappedHeaders: string[]
} {
  const contract = getNewMediaImportContract(sourceKind)
  const normalized = headers.map(normalizeImportHeader)
  const mapping: Record<string, number> = {}
  const usedIndexes = new Set<number>()
  for (const column of contract.columns) {
    const index = normalized.findIndex((header, position) => !usedIndexes.has(position) && header !== '' && column.aliases.some((alias) => normalizeImportHeader(alias) === header))
    if (index >= 0) {
      mapping[column.field] = index
      usedIndexes.add(index)
    }
  }
  const matchedFields = Object.keys(mapping)
  const missingRequired = contract.columns.filter((column) => column.required && mapping[column.field] === undefined).map((column) => column.field)
  const unmappedHeaders = headers.filter((_, position) => !usedIndexes.has(position) && normalized[position] !== '')
  return { mapping, matchedFields, missingRequired, unmappedHeaders }
}

export function importColumnKind(sourceKind: NewMediaImportSourceKind, field: string): NewMediaImportMetricKind | undefined {
  return getNewMediaImportContract(sourceKind).columns.find((column) => column.field === field)?.kind
}

export function isCommercialSource(sourceKind: NewMediaImportSourceKind): boolean {
  return getNewMediaImportContract(sourceKind).commercial
}
