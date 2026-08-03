/**
 * 钉钉文档拉取器 — DingTalk Doc Fetcher
 *
 * 从钉钉云文档（在线文档/知识库）拉取会议文档内容，
 * 供 LLM 提取任务草稿使用（会议文档 → tasks/subtasks 自动转化）。
 *
 * 注意：钉钉文档开放 API 的路径与权限随企业应用配置而异。
 * 实现基于钉钉开放平台「文档/知识库」常见接口，接入前需确认：
 * - 企业应用已开通「钉钉文档」读取权限
 * - 使用的接口路径与当前钉钉开放平台文档一致
 *
 * 凭证来源：与 dingtalk-todo-provider 相同的 Bot Hub 加密凭证。
 */

const DINGTALK_API_BASE = 'https://api.dingtalk.com/v1.0'

export interface DingTalkDocFetchResult {
  title: string
  content: string
  /** 原始文档 URL */
  sourceUrl: string
}

export class DingTalkDocFetcher {
  readonly name = 'dingtalk-doc'
  private appKey: string
  private appSecret: string
  private tokenCache: { token: string; expiresAt: number } | null = null

  constructor(config: { appKey: string; appSecret: string }) {
    this.appKey = config.appKey
    this.appSecret = config.appSecret
  }

  /** 获取 access_token（带本地缓存） */
  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token
    }
    const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(this.appKey)}&appsecret=${encodeURIComponent(this.appSecret)}`
    const resp = await fetch(url)
    const data = (await resp.json()) as { errcode?: number; access_token?: string; expires_in?: number }
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`钉钉获取 access_token 失败: ${JSON.stringify(data)}`)
    }
    const token = data.access_token
    if (!token) throw new Error('钉钉 access_token 为空')
    this.tokenCache = { token, expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000 }
    return token
  }

  /**
   * 从钉钉文档 URL 解析 nodeId。
   * 支持形如 https://alidocs.dingtalk.com/i/nodes/{nodeId} 的链接。
   */
  static parseNodeIdFromUrl(url: string): string | null {
    const match = url.match(/nodes\/([A-Za-z0-9_-]+)/)
    return match?.[1] ?? null
  }

  /**
   * 拉取钉钉文档内容。
   *
   * @param docUrl 钉钉在线文档链接（https://alidocs.dingtalk.com/i/nodes/{nodeId}）
   */
  async fetchDoc(docUrl: string): Promise<DingTalkDocFetchResult> {
    const nodeId = DingTalkDocFetcher.parseNodeIdFromUrl(docUrl)
    if (!nodeId) {
      throw new Error('无法从文档链接解析 nodeId，请确认是钉钉在线文档链接（alidocs.dingtalk.com/i/nodes/...）')
    }
    const content = await this.fetchNodeContent(nodeId)
    return {
      title: nodeId,
      content,
      sourceUrl: docUrl,
    }
  }

  /** 读取文档节点内容（钉钉文档 API；路径需按开放平台当前文档确认） */
  private async fetchNodeContent(nodeId: string): Promise<string> {
    const token = await this.getAccessToken()
    // 常见实现一：文档节点内容接口
    // 若接口路径与当前开放平台不一致，可在此替换为 wiki 知识库接口
    const url = `${DINGTALK_API_BASE}/doc/nodes/${encodeURIComponent(nodeId)}/content?access_token=${encodeURIComponent(token)}`
    const resp = await fetch(url)
    const data = (await resp.json()) as { errcode?: number; content?: string; text?: string }
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`钉钉文档拉取失败 (${data.errcode}): ${JSON.stringify(data)}`)
    }
    const content = data.content ?? data.text
    if (!content) throw new Error('钉钉文档返回内容为空')
    return content
  }
}

/** 从设置创建文档拉取器（未配置时返回 null） */
export async function createDingTalkDocFetcherFromConfig(): Promise<DingTalkDocFetcher | null> {
  try {
    const { getSettings } = await import('./settings-service')
    const settings = getSettings()
    const dingtalkTodo = settings.dingtalkTodo
    if (!dingtalkTodo?.enabled) return null

    if (dingtalkTodo.botId) {
      const { getDingTalkBotById, getDecryptedBotClientSecret } = await import('./dingtalk-config')
      const bot = getDingTalkBotById(dingtalkTodo.botId)
      const appSecret = bot ? getDecryptedBotClientSecret(bot.id) : ''
      if (!bot?.clientId || !appSecret) return null
      return new DingTalkDocFetcher({ appKey: bot.clientId, appSecret })
    }
    if (dingtalkTodo.appKey && dingtalkTodo.appSecret) {
      return new DingTalkDocFetcher({ appKey: dingtalkTodo.appKey, appSecret: dingtalkTodo.appSecret })
    }
    return null
  } catch (error) {
    console.error('[DingTalkDocFetcher] 创建失败:', error)
    return null
  }
}
