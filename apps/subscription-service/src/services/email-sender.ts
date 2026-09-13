/**
 * 邮件发送服务。
 *
 * 通过 Resend HTTP API 发送验证码邮件。
 * 未配置 API Key 时（本地开发）走控制台输出，便于联调。
 *
 * 安全约定：投递凭据只通过环境变量注入，不写入代码或日志。
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface EmailSenderConfig {
  apiKey?: string
  /** 发件人，格式如 "Gravitas <noreply@example.com>" */
  from?: string
  /** 生产环境必须显式允许控制台回退；默认禁用以避免误把验证码打进日志 */
  allowConsoleFallback?: boolean
  fetchImpl?: FetchLike
}

export interface SendOtpEmailInput {
  to: string
  code: string
  expiresMinutes: number
}

export type SendEmailOutcome =
  | { ok: true; channel: 'resend' | 'console' }
  | { ok: false; reason: 'not_configured' | 'send_failed'; detail?: string }

export class EmailSender {
  private readonly fetchImpl: FetchLike

  constructor(private readonly config: EmailSenderConfig) {
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init))
  }

  private isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.from)
  }

  async sendOtpEmail(input: SendOtpEmailInput): Promise<SendEmailOutcome> {
    if (!this.isConfigured()) {
      // 开发环境：不配置凭据时输验证码到控制台，方便本地联调。
      // 生产环境必须配置凭据，否则用户收不到验证码。
      if (this.config.allowConsoleFallback) {
        console.log(`[email] 未配置邮件服务，验证码（仅开发可见）: ${input.code}`)
        return { ok: true, channel: 'console' }
      }
      return { ok: false, reason: 'not_configured' }
    }

    const subject = 'Gravitas 登录验证码'
    const text = [
      `你的登录验证码是：${input.code}`,
      '',
      `验证码 ${input.expiresMinutes} 分钟内有效，请勿转发给他人。`,
      '若非本人操作，请忽略本邮件。',
    ].join('\n')

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px">
        <h2 style="margin:0 0 16px">Gravitas 登录验证码</h2>
        <p style="font-size:32px;letter-spacing:8px;font-weight:600;margin:16px 0">${input.code}</p>
        <p style="color:#666;font-size:14px">验证码 ${input.expiresMinutes} 分钟内有效，请勿转发给他人。</p>
        <p style="color:#999;font-size:13px">若非本人操作，请忽略本邮件。</p>
      </div>
    `.trim()

    try {
      const response = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [input.to],
          subject,
          text,
          html,
        }),
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        // 注意：不记录收件人与验证码，只记录状态与截断的错误信息
        return { ok: false, reason: 'send_failed', detail: detail.slice(0, 200) }
      }

      return { ok: true, channel: 'resend' }
    } catch (error) {
      return {
        ok: false,
        reason: 'send_failed',
        detail: error instanceof Error ? error.message : 'unknown',
      }
    }
  }
}
