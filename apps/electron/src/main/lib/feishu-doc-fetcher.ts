/**
 * 飞书文档拉取器 — Feishu Doc Fetcher
 *
 * 从飞书云文档（新版文档 docx / 电子表格 sheets / 知识库 wiki）拉取会议文档内容，
 * 供 LLM 提取任务草稿使用（会议文档 → tasks/subtasks 自动转化）。
 *
 * 支持三种类型（由 URL 自动识别）：
 * - docx   https://{domain}.feishu.cn/docx/{document_id}
 * - sheets https://{domain}.feishu.cn/sheets/{spreadsheet_token}
 * - wiki   https://{domain}.feishu.cn/wiki/{node_token}
 *
 * 前提：企业应用（Bot）已开通对应读取权限
 * - 新版文档：查看新版文档
 * - 电子表格：查看电子表格 / 查看表格
 * - 知识库： 查看知识空间 / 查看知识库节点
 *
 * 凭证来源：与 feishu-todo-provider 相同的 Bot Hub 加密凭证（app_id / app_secret）。
 */

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis'

export interface FeishuDocFetchResult {
  title: string
  content: string
  /** 原始文档 URL */
  sourceUrl: string
}

/** URL 中识别的文档类型路由 */
export type FeishuDocKind = 'docx' | 'sheets' | 'wiki'

const MAX_SHEET_ROWS = 200
const MAX_SHEET_COLS = 20

export class FeishuDocFetcher {
  readonly name = 'feishu-doc'
  private appId: string
  private appSecret: string
  private tokenCache: { token: string; expiresAt: number } | null = null

  constructor(config: { appId: string; appSecret: string }) {
    this.appId = config.appId
    this.appSecret = config.appSecret
  }

  /** 获取 tenant_access_token（带本地缓存） */
  private async getTenantAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token
    }
    const resp = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    const data = (await resp.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (data.code !== 0) {
      throw new Error(`飞书获取 tenant_access_token 失败: ${data.msg} (code: ${data.code})`)
    }
    const token = data.tenant_access_token
    if (!token) throw new Error('飞书 tenant_access_token 为空')
    this.tokenCache = { token, expiresAt: Date.now() + (data.expire ?? 7200) * 1000 }
    return token
  }

  /**
   * 从飞书文档 URL 解析类型与资源 id。
   * 支持形如 https://{domain}.feishu.cn/docx/{id} 的链接。
   */
  static parseFeishuUrl(
    url: string
  ): { kind: FeishuDocKind; id: string } | null {
    const trimmed = url.trim()
    // 兼容带查询参数：https://xxx.feishu.cn/docx/{id}?from=xxx
    const clean = trimmed.split('?')[0] ?? trimmed
    const match = clean.match(/[/.](docx|sheets|wiki)\/([A-Za-z0-9_\-]+)/)
    if (!match) return null
    const kind = match[1] as FeishuDocKind
    const id = match[2] ?? ''
    if (!id) return null
    return { kind, id }
  }

  /**
   * 拉取飞书文档内容。
   *
   * @param docUrl 飞书文档链接（docx / sheets / wiki）
   */
  async fetchDoc(docUrl: string): Promise<FeishuDocFetchResult> {
    const parsed = FeishuDocFetcher.parseFeishuUrl(docUrl)
    if (!parsed) {
      throw new Error('无法从文档链接解析飞书文档，请确认是飞书链接（docx / sheets / wiki 域名 feishu.cn）')
    }
    const { kind, id } = parsed
    const token = await this.getTenantAccessToken()

    if (kind === 'wiki') {
      return this.fetchWikiNode(token, id, docUrl)
    }
    if (kind === 'sheets') {
      return this.fetchSpreadsheet(token, id, docUrl)
    }
    return this.fetchDocx(token, id, docUrl)
  }

  /** 读取新版文档纯文本内容 */
  private async fetchDocx(token: string, documentId: string, sourceUrl: string): Promise<FeishuDocFetchResult> {
    const url = `${FEISHU_API_BASE}/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`
    const data = await this.getWithError(token, url, '新版文档')
    // raw_content 接口返回结构为 { code, data: { content } }，content 在 data 内层
    const content = typeof asRecord(data.data).content === 'string' ? String(asRecord(data.data).content) : ''
    if (!content) throw new Error('飞书文档返回内容为空')
    return { title: documentId, content, sourceUrl }
  }

  /** 读取电子表格内容：取第一个工作表，读前若干行作为会议纪要 */
  private async fetchSpreadsheet(token: string, spreadsheetToken: string, sourceUrl: string): Promise<FeishuDocFetchResult> {
    // 1. 查询工作表列表，取第一个工作表
    const listUrl = `${FEISHU_API_BASE}/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`
    const list = await this.getWithError(token, listUrl, '电子表格')
    const dataNode = asRecord(list.data)
    const sheets = asArray(dataNode.sheets) as Array<{ sheet_id?: string; title?: string }>
    const sheet = sheets[0]
    if (!sheet?.sheet_id) {
      throw new Error('电子表格中没有可读取的工作表')
    }

    // 2. 读取首个工作表前 MAX_SHEET_ROWS × MAX_SHEET_COLS 单元格
    const range = `${sheet.sheet_id}!A1:${toColName(Math.max(1, MAX_SHEET_COLS))}${MAX_SHEET_ROWS}`
    const valuesUrl = `${FEISHU_API_BASE}/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`
    const vals = await this.getWithError(token, valuesUrl, '电子表格')

    const valueRange = asRecord(asRecord(vals.data).valueRange)
    const rows = asArray(valueRange.values) as unknown[][]
    const content = rows
      .map((row) => (Array.isArray(row) ? row.map((cell) => (cell == null ? '' : String(cell))).join('\t') : ''))
      .filter((line) => line.trim() !== '')
      .join('\n')
    if (!content) throw new Error('电子表格对应区域内容为空')

    const title = sheet.title || spreadsheetToken
    return { title, content, sourceUrl }
  }

  /** 读取知识库节点内容：先取 obj_type/obj_token，再按类型路由 */
  private async fetchWikiNode(token: string, nodeToken: string, sourceUrl: string): Promise<FeishuDocFetchResult> {
    const url = `${FEISHU_API_BASE}/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`
    const data = await this.getWithError(token, url, '知识库')
    const node = asRecord(asRecord(data.data).node) as {
      obj_type?: string
      obj_token?: string
      title?: string
      node_token?: string
    }
    const objType = typeof node.obj_type === 'string' ? node.obj_type : undefined
    const objToken = typeof node.obj_token === 'string' ? node.obj_token : undefined
    if (!objToken) throw new Error('无法从知识库节点获取文档 token')

    const sourceTitle =
      (typeof node.title === 'string' && node.title ? node.title : undefined) ??
      (typeof node.node_token === 'string' ? node.node_token : undefined) ??
      nodeToken

    if (objType === 'doc' || objType === 'docx') {
      const result = await this.fetchDocx(token, objToken, sourceUrl)
      return { ...result, title: sourceTitle }
    }
    if (objType === 'sheet') {
      const result = await this.fetchSpreadsheet(token, objToken, sourceUrl)
      // 标题以知识库节点名称为准
      return { ...result, title: sourceTitle }
    }
    if (objType === 'bitable') {
      return this.fetchBitable(token, objToken, sourceUrl, sourceTitle)
    }
    throw new Error(`暂不支持读取知识库节点类型: ${objType ?? '未知'}`)
  }

  /** 读取多维表格（bitable）内容：取第一个数据表的前若干条记录 */
  private async fetchBitable(token: string, appToken: string, sourceUrl: string, fallbackTitle: string): Promise<FeishuDocFetchResult> {
    // 1. 列出数据表，取第一个 table_id
    const tablesUrl = `${FEISHU_API_BASE}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`
    const tables = await this.getWithError(token, tablesUrl, '多维表格')
    const tableList = asArray(asRecord(tables.data).items) as Array<{ table_id?: string; name?: string }>
    const table = tableList[0] as { table_id?: string; name?: string } | undefined
    if (!table?.table_id) throw new Error('多维表格中没有可读取的数据表')

    // 2. 读取首表前 MAX_SHEET_ROWS 条记录（不含附件/索引字段，简化输出）
    const recordsUrl = `${FEISHU_API_BASE}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(table.table_id)}/records?page_size=${MAX_SHEET_ROWS}`
    const recs = await this.getWithError(token, recordsUrl, '多维表格')
    const items = asArray(asRecord(recs.data).items) as Array<{ fields?: Record<string, unknown> }>

    const lines: string[] = []
    for (const item of items) {
      const fields = asRecord(item.fields)
      // 序列化各字段：复杂对象转为 JSON，简单值直接 toString
      const parts = Object.entries(fields).map(([k, v]) => {
        if (v == null) return `${k}:`
        if (typeof v === 'object') return `${k}: ${JSON.stringify(v)}`
        return `${k}: ${String(v)}`
      })
      if (parts.length > 0) lines.push(parts.join(' | '))
    }
    const content = lines.join('\n')
    if (!content) throw new Error('多维表格对应区域内容为空')

    return { title: table.name || fallbackTitle, content, sourceUrl }
  }

  /** 通用 GET 请求 + 错误归一化 */
  private async getWithError(token: string, url: string, label: string): Promise<Record<string, unknown>> {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const data = (await resp.json()) as Record<string, unknown>
    const code = typeof data.code === 'number' ? data.code : resp.status
    if (code !== 0) {
      const msg = typeof data.msg === 'string' ? data.msg : String(data.msg ?? '')
      // 常见权限错误给出可读提示
      if (code === 99991672 || code === 91604 || code === 99991600) {
        throw new Error(`飞书${label}拉取失败：权限不足，请在飞书开放平台为企业应用（Bot）开通「查看${label}」权限`)
      }
      throw new Error(`飞书${label}拉取失败: ${msg} (code: ${code})`)
    }
    return data
  }
}

/** 私有辅助：将 Record<string, unknown> 中某字段安全解析为对象 */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** 私有辅助：安全取数组 */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** 列索引 → 列名字母（1 → A, 26 → Z, 27 → AA） */
function toColName(n: number): string {
  let s = ''
  let val = n
  while (val > 0) {
    const rem = (val - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    val = Math.floor((val - 1) / 26)
  }
  return s || 'A'
}

/** 从设置创建飞书文档拉取器（未配置时返回 null） */
export async function createFeishuDocFetcherFromConfig(): Promise<FeishuDocFetcher | null> {
  try {
    const { getSettings } = await import('./settings-service')
    const settings = getSettings()
    const feishuTodo = settings.feishuTodo
    if (!feishuTodo?.enabled) return null

    const { getFeishuBotById, getDecryptedBotAppSecret } = await import('./feishu-config')
    const bot = feishuTodo.botId ? getFeishuBotById(feishuTodo.botId) : undefined
    // 注意：bot.appSecret 是 safeStorage 加密后的密文，必须解密后才能换取 tenant_access_token
    const appSecret = bot?.appId ? getDecryptedBotAppSecret(bot.id) : ''
    if (!bot?.appId || !appSecret) return null
    return new FeishuDocFetcher({ appId: bot.appId, appSecret })
  } catch (error) {
    console.error('[FeishuDocFetcher] 创建失败:', error)
    return null
  }
}
