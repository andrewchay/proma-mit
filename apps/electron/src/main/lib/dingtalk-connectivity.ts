/**
 * 钉钉连通性自检 — DingTalk Connectivity Check
 *
 * 配置好钉钉 Bot 后一键验证：
 * 1. 凭证完整性（Bot Hub 中的 App ID / App Secret）
 * 2. access_token 获取（验证凭证有效 + 网络可达）
 * 3. 群机器人 Webhook 可达性（可选，会真实发送一条测试消息）
 *
 * 用于排查「钉钉权限已开通但功能不生效」的问题。
 */

export interface ConnectivityStep {
  name: string
  ok: boolean
  detail?: string
}

export interface ConnectivityResult {
  success: boolean
  steps: ConnectivityStep[]
}

/** 执行钉钉连通性自检 */
export async function testDingTalkConnection(options?: {
  /** 是否发送测试机器人消息（会真实发一条到群里） */
  sendTestMessage?: boolean
}): Promise<ConnectivityResult> {
  const steps: ConnectivityStep[] = []

  // 1. 读取凭证
  let appKey = ''
  let appSecret = ''
  let robotWebhook = ''
  let robotWebhookSecret = ''
  try {
    const { getSettings } = await import('./settings-service')
    const settings = getSettings()
    const todoConfig = settings.dingtalkTodo
    if (todoConfig?.botId) {
      const { getDingTalkBotById, getDecryptedBotClientSecret } = await import('./dingtalk-config')
      const bot = getDingTalkBotById(todoConfig.botId)
      const secret = bot ? getDecryptedBotClientSecret(bot.id) : ''
      if (!bot?.clientId || !secret) {
        steps.push({ name: '凭证完整性', ok: false, detail: '所选钉钉 Bot 的 App ID / App Secret 不完整，请到「远程连接 → 钉钉」重新保存' })
      } else {
        appKey = bot.clientId
        appSecret = secret
        steps.push({ name: '凭证完整性', ok: true, detail: `Bot「${bot.name}」App ID ${bot.clientId.slice(0, 12)}... 凭证完整` })
      }
    } else if (todoConfig?.appKey && todoConfig?.appSecret) {
      appKey = todoConfig.appKey
      appSecret = todoConfig.appSecret
      steps.push({ name: '凭证完整性', ok: true, detail: '使用旧版直接配置的凭证' })
    } else {
      steps.push({ name: '凭证完整性', ok: false, detail: '未配置钉钉 Bot，请先在设置中选择已保存的 Bot' })
    }
    robotWebhook = todoConfig?.robotWebhook ?? ''
    robotWebhookSecret = todoConfig?.robotWebhookSecret ?? ''
  } catch (error) {
    steps.push({ name: '读取配置', ok: false, detail: error instanceof Error ? error.message : String(error) })
  }

  // 2. access_token 获取
  if (appKey && appSecret) {
    try {
      const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      const data = (await resp.json()) as { errcode?: number; errmsg?: string; access_token?: string }
      if (data.errcode && data.errcode !== 0) {
        steps.push({ name: 'access_token 获取', ok: false, detail: `钉钉返回 ${data.errcode}: ${data.errmsg ?? '未知错误'}` })
      } else if (data.access_token) {
        steps.push({ name: 'access_token 获取', ok: true, detail: '凭证有效，可以调用钉钉开放平台 API' })
      } else {
        steps.push({ name: 'access_token 获取', ok: false, detail: '响应中无 access_token' })
      }
    } catch (error) {
      steps.push({ name: 'access_token 获取', ok: false, detail: `网络错误: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  // 3. 群机器人 Webhook（可选，会真实发送）
  if (options?.sendTestMessage && robotWebhook) {
    try {
      const { sendDingTalkRobotMessage } = await import('./dingtalk-todo-provider')
      const result = await sendDingTalkRobotMessage({
        title: 'PAA 连通性测试',
        text: '**✅ PAA 钉钉连通性测试**\n\n如果你看到这条消息，说明群机器人 Webhook 配置正确。',
      })
      if (result.success) {
        steps.push({ name: '群机器人 Webhook', ok: true, detail: '测试消息已发送，请到钉钉群确认收到' })
      } else {
        steps.push({ name: '群机器人 Webhook', ok: false, detail: result.error })
      }
    } catch (error) {
      steps.push({ name: '群机器人 Webhook', ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  } else if (options?.sendTestMessage) {
    steps.push({ name: '群机器人 Webhook', ok: false, detail: '未配置群机器人 Webhook，跳过测试（不影响待办同步）' })
  }

  return {
    success: steps.every((step) => step.ok),
    steps,
  }
}

/** 飞书连通性自检（飞书可控性更高，适合优先测试） */
export async function testFeishuConnection(): Promise<ConnectivityResult> {
  const steps: ConnectivityStep[] = []

  // 1. 读取飞书 Bot 凭证
  let appId = ''
  let appSecret = ''
  try {
    const { getSettings } = await import('./settings-service')
    const settings = getSettings()
    const feishuTodo = settings.feishuTodo
    if (!feishuTodo?.enabled) {
      steps.push({ name: '飞书 Todo 配置', ok: false, detail: '飞书 Todo 同步未启用，请先到「设置 → 外部平台」启用' })
    } else if (feishuTodo.botId) {
      const { getFeishuMultiBotConfig, getDecryptedBotAppSecret } = await import('./feishu-config')
      const config = getFeishuMultiBotConfig()
      const bot = config.bots.find((b) => b.id === feishuTodo.botId && b.enabled && b.appId && b.appSecret)
      if (!bot) {
        steps.push({ name: '飞书 Bot 凭证', ok: false, detail: `未找到已配置的飞书 Bot ${feishuTodo.botId}` })
      } else {
        appId = bot.appId
        // bot.appSecret 是 safeStorage 加密后的密文，必须解密后才能换取 tenant_access_token
        appSecret = getDecryptedBotAppSecret(bot.id)
        const { safeStorage } = await import('electron')
        steps.push({
          name: '飞书 Bot 凭证',
          ok: true,
          detail: `Bot「${bot.name}」凭证完整（解密 Secret 长度 ${appSecret.length}，头部 ${appSecret.slice(0, 2)}${'•'.repeat(Math.max(appSecret.length - 4, 0))}${appSecret.slice(-2)}，safeStorage ${safeStorage.isEncryptionAvailable() ? '可用' : '不可用'}）`,
        })
      }
    } else {
      steps.push({ name: '飞书 Todo 配置', ok: false, detail: '未选择飞书 Bot，请先选择' })
    }
  } catch (error) {
    steps.push({ name: '读取配置', ok: false, detail: error instanceof Error ? error.message : String(error) })
  }

  // 2. tenant_access_token 获取
  if (appId && appSecret) {
    // 2.1 解密值自检：Secret 不应是密文 base64、不应为空、不应带空白
    if (appSecret.length < 8 || /\s/.test(appSecret)) {
      steps.push({ name: 'tenant_access_token 获取', ok: false, detail: '存储的 App Secret 疑似无效（长度过短或含空白）。请到「远程连接 → 飞书」重新粘贴并「保存」后再试' })
      return { success: false, steps }
    }
    try {
      const lark = await import('@larksuiteoapi/node-sdk')
      const client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild })
      const resp = await client.auth.tenantAccessToken.internal({
        data: { app_id: appId, app_secret: appSecret },
      })
      if (resp.code !== 0) {
        const hint = resp.code === 10014
          ? 'App Secret 与 App ID 不匹配（或存储的是旧值）。请到「远程连接 → 飞书」确认已用后台最新凭证点击「保存」，然后重启应用再试'
          : `飞书返回 ${resp.code}: ${resp.msg}`
        steps.push({ name: 'tenant_access_token 获取', ok: false, detail: hint })
      } else {
        steps.push({ name: 'tenant_access_token 获取', ok: true, detail: '凭证有效，可以调用飞书开放平台 API' })
      }
    } catch (error) {
      steps.push({ name: 'tenant_access_token 获取', ok: false, detail: `调用失败: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  return { success: steps.every((step) => step.ok), steps }
}
