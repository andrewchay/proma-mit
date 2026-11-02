/**
 * 飞书审批卡片（票拟 + 批红，借鉴卡兹克「批奏折」交互）
 *
 * - 票拟：Agent 权限请求外推为带选项按钮的飞书卡片，人看一眼点确认
 * - 批红：点击后 resolve 请求，卡片原位更新为结论，Agent 续跑
 *
 * 本模块只做纯函数（构建卡片 JSON / 解析按钮值），不依赖 SDK 与网络，便于测试。
 * 接线在 feishu-bridge：cardAction 回调 → parse → respondToPermission → 卡片回写。
 */

import type { DangerLevel, PermissionRequest } from '@gravitas/shared'

/** 卡片按钮 value 中的自定义键（避免与其他卡片 action 冲突） */
export const APPROVAL_CARD_ACTION_KEY = '__gravitas_approval'

/** 审批卡片按钮携带的决策载荷 */
export interface ApprovalCardAction {
  kind: 'permission'
  requestId: string
  decision: 'allow' | 'deny'
}

/** 危险等级 → 卡片头颜色模板 */
function dangerTemplate(dangerLevel: DangerLevel): string {
  if (dangerLevel === 'dangerous') return 'red'
  if (dangerLevel === 'safe') return 'green'
  return 'orange'
}

function dangerLabel(dangerLevel: DangerLevel): string {
  if (dangerLevel === 'dangerous') return '高危'
  if (dangerLevel === 'safe') return '安全'
  return '普通'
}

/** 截断工具输入摘要，避免卡片过长 */
function summarizeInput(toolInput: Record<string, unknown>, max = 400): string {
  try {
    const text = JSON.stringify(toolInput)
    return text.length > max ? `${text.slice(0, max)}…` : text
  } catch {
    return '(无法序列化的输入)'
  }
}

function sessionShort(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId
}

/**
 * 构建权限请求的「票拟」卡片：带 [允许] [拒绝] 按钮。
 * 按钮 value 携带 APPROVAL_CARD_ACTION_KEY 载荷，回调侧用 parseApprovalCardAction 解析。
 */
export function buildPermissionApprovalCard(request: PermissionRequest): Record<string, unknown> {
  const commandLines = request.command
    ? `**命令**\n\`\`\`\n${request.command.slice(0, 600)}\n\`\`\`\n`
    : ''
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🛡️ Agent 权限请求｜${dangerLabel(request.dangerLevel)}` },
      template: dangerTemplate(request.dangerLevel),
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**工具**：${request.sdkDisplayName ?? request.toolName}`,
            `**操作**：${request.description || '(无描述)'}`,
            commandLines,
            `**会话**：${sessionShort(request.sessionId)}`,
            `**输入**：\n\`\`\`\n${summarizeInput(request.toolInput)}\n\`\`\``,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '票拟：Agent 请求执行以上操作，点击即批红。仅限授权用户操作。' }],
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 允许' },
            type: 'primary',
            value: { [APPROVAL_CARD_ACTION_KEY]: { kind: 'permission', requestId: request.requestId, decision: 'allow' } },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { [APPROVAL_CARD_ACTION_KEY]: { kind: 'permission', requestId: request.requestId, decision: 'deny' } },
          },
        ],
      },
    ],
  }
}

/**
 * 解析卡片按钮回调的 value；非审批按钮返回 null。
 * 载荷结构非法（缺字段/类型错）同样返回 null，由调用方忽略。
 */
export function parseApprovalCardAction(value: unknown): ApprovalCardAction | null {
  if (!value || typeof value !== 'object') return null
  const payload = (value as Record<string, unknown>)[APPROVAL_CARD_ACTION_KEY]
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (p.kind !== 'permission') return null
  if (typeof p.requestId !== 'string' || !p.requestId) return null
  if (p.decision !== 'allow' && p.decision !== 'deny') return null
  return { kind: 'permission', requestId: p.requestId, decision: p.decision }
}

/** 决策 → 结果卡标题与颜色（批红回写） */
function resultHeader(decision: 'allow' | 'deny'): { title: string; template: string } {
  return decision === 'allow'
    ? { title: '✅ 已允许', template: 'green' }
    : { title: '❌ 已拒绝', template: 'grey' }
}

/**
 * 构建「批红」后的结果卡片：原位替换请求卡，展示结论与操作人。
 */
export function buildApprovalResultCard(
  request: PermissionRequest,
  decision: 'allow' | 'deny',
  operatorName: string | undefined,
  decidedAt = Date.now(),
): Record<string, unknown> {
  const header = resultHeader(decision)
  const time = new Date(decidedAt).toLocaleString('zh-CN', { hour12: false })
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${header.title}｜${request.sdkDisplayName ?? request.toolName}` },
      template: header.template,
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**操作**：${request.description || '(无描述)'}\n**批红人**：${operatorName ?? '(未知)'}\n**时间**：${time}`,
        },
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `决策已回写会话 ${sessionShort(request.sessionId)}，Agent 继续执行。` }],
      },
    ],
  }
}

/** 卡片已失效（请求已被桌面端处理或超时）时的提示卡 */
export function buildApprovalStaleCard(decision: 'allow' | 'deny'): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⌛ 请求已失效' },
      template: 'grey',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '该权限请求已在桌面端处理或已超时，本次点击未生效。请以最新请求为准。',
        },
      },
    ],
  }
}
